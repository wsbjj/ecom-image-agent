import { app, nativeImage } from 'electron'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import type { GenerateImageParams, GenerateImageResult, ImageProvider } from './base'

const VISUAL_HOST = 'visual.volcengineapi.com'
const VISUAL_ENDPOINT = `https://${VISUAL_HOST}`
const VISUAL_SERVICE = 'cv'
const VISUAL_REGION = 'cn-north-1'
const VISUAL_VERSION = '2022-08-31'

const DEFAULT_T2I_REQ_KEY = 'high_aes_general_v30l_zt2i'
const I2I_REQ_KEY = 'seededit_v3.0'
const I2I_DEFAULT_SCALE = 0.5
const I2I_DEFAULT_SEED = -1

const MAX_I2I_INPUT_BYTES = 5 * 1024 * 1024
const MAX_I2I_INPUT_DIMENSION = 4096
const MIN_RESIZE_SIDE = 512
const POLL_TIMEOUT_MS = 120_000

const ASPECT_TO_SIZE: Record<string, { width: number; height: number }> = {
  '1:1': { width: 1328, height: 1328 },
  '4:3': { width: 1472, height: 1104 },
  '16:9': { width: 1664, height: 936 },
}

interface VisualApiResponse<TData> {
  code: number
  message: string
  request_id?: string
  data: TData | null
}

interface VisualMetadataErrorShape {
  CodeN?: number
  Code?: string
  Message?: string
}

interface VisualMetadataShape {
  RequestId?: string
  Error?: VisualMetadataErrorShape
}

interface SubmitTaskData {
  task_id: string
}

interface GetResultData {
  status: 'in_queue' | 'generating' | 'done' | 'not_found' | 'expired'
  image_urls?: string[]
  binary_data_base64?: string[] | null
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function hmacHex(key: Buffer | string, value: string): string {
  return crypto.createHmac('sha256', key).update(value).digest('hex')
}

function hmacBuffer(key: Buffer | string, value: string): Buffer {
  return crypto.createHmac('sha256', key).update(value).digest()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function formatAmzDate(now: Date): { shortDate: string; longDate: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return {
    shortDate: iso.slice(0, 8),
    longDate: `${iso.slice(0, 15)}Z`,
  }
}

function isRetriableCode(code: number): boolean {
  return code === 50429 || code === 50430
}

function isAuthLikeError(message: string): boolean {
  return /SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied|Unauthorized|AuthFailure|code=100010/i.test(
    message,
  )
}

function parseVisualResponsePayload<TData>(
  httpStatus: number,
  payloadText: string,
): VisualApiResponse<TData> {
  let payload: unknown
  try {
    payload = JSON.parse(payloadText)
  } catch {
    return {
      code: httpStatus,
      message: `Visual API returned non-JSON payload: ${payloadText.slice(0, 200)}`,
      data: null,
    }
  }

  if (typeof payload !== 'object' || payload === null) {
    return {
      code: httpStatus,
      message: `Visual API returned invalid payload: ${String(payload).slice(0, 200)}`,
      data: null,
    }
  }

  const direct = payload as Partial<VisualApiResponse<TData>>
  if (typeof direct.code === 'number') {
    return {
      code: direct.code,
      message: typeof direct.message === 'string' ? direct.message : '',
      request_id: typeof direct.request_id === 'string' ? direct.request_id : undefined,
      data: (direct.data as TData | null | undefined) ?? null,
    }
  }

  const metadata = (payload as { ResponseMetadata?: VisualMetadataShape }).ResponseMetadata
  if (metadata?.Error) {
    const errorCodeN = metadata.Error.CodeN
    const errorCode = metadata.Error.Code
    const errorMessage = metadata.Error.Message ?? 'Unknown Visual API error'
    return {
      code: typeof errorCodeN === 'number' ? errorCodeN : httpStatus,
      message: errorCode ? `${errorCode}: ${errorMessage}` : errorMessage,
      request_id: metadata.RequestId,
      data: null,
    }
  }

  return {
    code: httpStatus,
    message: `Visual API returned unknown payload shape: ${payloadText.slice(0, 200)}`,
    data: null,
  }
}

function percentEncode(source: string): string {
  return encodeURIComponent(source).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function buildCanonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`)
    .join('&')
}

export const __visualSignInternal = {
  percentEncode,
  buildCanonicalQuery,
}

function supportedImageExt(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return ext === '.jpg' || ext === '.jpeg' || ext === '.png'
}

function encodeJpegWithLimit(image: Electron.NativeImage): Buffer {
  const qualities = [90, 80, 70, 60, 50, 40]
  let working = image
  for (let pass = 0; pass < 5; pass += 1) {
    for (const quality of qualities) {
      const jpeg = working.toJPEG(quality)
      if (jpeg.length <= MAX_I2I_INPUT_BYTES) {
        return jpeg
      }
    }
    const size = working.getSize()
    const nextWidth = Math.max(MIN_RESIZE_SIDE, Math.floor(size.width * 0.85))
    const nextHeight = Math.max(MIN_RESIZE_SIDE, Math.floor(size.height * 0.85))
    if (nextWidth === size.width && nextHeight === size.height) {
      break
    }
    working = working.resize({ width: nextWidth, height: nextHeight, quality: 'good' })
  }
  throw new Error('Visual I2I input image cannot be compressed under 5MB')
}

export class SeedreamVisualProvider implements ImageProvider {
  readonly name = 'seedream-visual' as const
  private readonly accessKeyId?: string
  private readonly secretAccessKey?: string
  private readonly reqKey: string
  private readonly fallbackProvider?: ImageProvider

  constructor(options: {
    accessKeyId?: string
    secretAccessKey?: string
    reqKey?: string
    fallbackProvider?: ImageProvider
  }) {
    this.accessKeyId = options.accessKeyId?.trim()
    this.secretAccessKey = options.secretAccessKey?.trim()
    this.reqKey = options.reqKey?.trim() || DEFAULT_T2I_REQ_KEY
    this.fallbackProvider = options.fallbackProvider
  }

  async generate(params: GenerateImageParams): Promise<GenerateImageResult> {
    if (!this.accessKeyId || !this.secretAccessKey) {
      return this.callFallback(params, 'Official Visual missing AccessKey/SecretKey')
    }

    const productCount = params.productImagePaths.length
    const referenceCount = params.referenceImagePaths?.length ?? 0
    const hasInputImages = productCount + referenceCount > 0

    const size = ASPECT_TO_SIZE[params.aspectRatio ?? '1:1'] ?? ASPECT_TO_SIZE['1:1']
    const fullPrompt = `${params.prompt}${params.style ? `, style: ${params.style}` : ''}, e-commerce product photography, high quality, commercial grade`

    try {
      const visualRoute: 't2i' | 'i2i' = hasInputImages ? 'i2i' : 't2i'
      let submitBody: Record<string, unknown>
      let fallbackReason: string | undefined

      if (visualRoute === 'i2i') {
        submitBody = (await this.buildI2ISubmitBody(params, fullPrompt)).body
      } else {
        submitBody = {
          req_key: this.reqKey,
          prompt: fullPrompt,
          use_pre_llm: false,
          seed: I2I_DEFAULT_SEED,
          width: size.width,
          height: size.height,
        }
      }

      let submit: VisualApiResponse<SubmitTaskData>
      if (visualRoute === 'i2i') {
        try {
          submit = await this.postActionWithRetry<SubmitTaskData>('CVSync2AsyncSubmitTask', submitBody)
        } catch (error: unknown) {
          if (this.shouldRetryI2IWithSingleInput(error, params)) {
            const singleInputBody = await this.buildSingleInputI2ISubmitBody(params, fullPrompt)
            submit = await this.postActionWithRetry<SubmitTaskData>('CVSync2AsyncSubmitTask', singleInputBody)
            fallbackReason = 'visual_i2i_multi_input_rejected_retry_with_single_input'
          } else {
            throw error
          }
        }
      } else {
        submit = await this.postActionWithRetry<SubmitTaskData>('CVSync2AsyncSubmitTask', submitBody)
      }

      const taskId = submit.data?.task_id
      if (!taskId) {
        throw new Error(`Visual submit succeeded but task_id is missing, request_id=${submit.request_id ?? 'unknown'}`)
      }

      const result = await this.pollResult(taskId, visualRoute === 'i2i' ? I2I_REQ_KEY : this.reqKey)
      const imageUrl = result.imageUrl
      const requestId = result.requestId

      const tmpDir = path.join(app.getPath('userData'), 'tmp_images')
      await fs.mkdir(tmpDir, { recursive: true })
      const imagePath = path.join(tmpDir, `${uuidv4()}.png`)

      if (imageUrl.startsWith('data:')) {
        const base64Data = imageUrl.split(',')[1]
        await fs.writeFile(imagePath, Buffer.from(base64Data, 'base64'))
      } else {
        const response = await fetch(imageUrl)
        if (!response.ok) {
          throw new Error(`Download generated image failed: HTTP ${response.status}`)
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        await fs.writeFile(imagePath, buffer)
      }

      return {
        imagePath,
        promptUsed: fullPrompt,
        debugInfo: {
          providerMode: 'visual_official',
          requestId,
          taskId,
          visualRoute,
          fallbackReason,
          productImageCount: productCount,
          referenceImageCount: referenceCount,
          usedCompositeImage: false,
        },
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (isAuthLikeError(message)) {
        throw new Error(`Official Visual auth failed. Check AK/SK and IAM permission: ${message}`)
      }
      return this.callFallback(params, `Official Visual request failed: ${message}`)
    }
  }

  private async callFallback(
    params: GenerateImageParams,
    reason: string,
  ): Promise<GenerateImageResult> {
    if (!this.fallbackProvider) {
      throw new Error(reason)
    }
    try {
      const fallbackResult = await this.fallbackProvider.generate(params)
      return {
        ...fallbackResult,
        debugInfo: {
          ...fallbackResult.debugInfo,
          fallbackReason: reason,
        },
      }
    } catch (fallbackError: unknown) {
      const fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      throw new Error(`${reason}; fallback openai_compat also failed: ${fallbackMessage}`)
    }
  }

  private buildI2IPrompt(basePrompt: string, productCount: number, referenceCount: number): string {
    return [
      'Strictly preserve product identity (shape, material, proportions, and key details).',
      `Product image count=${productCount}, reference image count=${referenceCount}.`,
      referenceCount > 0
        ? 'Reference images are for style/lighting/color/composition only; do not alter product identity.'
        : '',
      `Target: ${basePrompt}`,
    ]
      .filter((text) => text.length > 0)
      .join(' ')
  }

  private async loadValidatedImage(imagePath: string): Promise<Electron.NativeImage> {
    if (!supportedImageExt(imagePath)) {
      throw new Error(`Visual I2I only supports JPG/PNG input: ${imagePath}`)
    }
    const stat = await fs.stat(imagePath)
    if (stat.size > MAX_I2I_INPUT_BYTES) {
      throw new Error(`Visual I2I input image exceeds 5MB: ${imagePath}`)
    }
    const image = nativeImage.createFromPath(imagePath)
    if (image.isEmpty()) {
      throw new Error(`Cannot read image: ${imagePath}`)
    }
    const { width, height } = image.getSize()
    if (width <= 0 || height <= 0) {
      throw new Error(`Invalid image size: ${imagePath}`)
    }
    if (width > MAX_I2I_INPUT_DIMENSION || height > MAX_I2I_INPUT_DIMENSION) {
      throw new Error(`Visual I2I input resolution exceeds 4096x4096: ${imagePath}`)
    }
    const ratio = Math.max(width, height) / Math.min(width, height)
    if (ratio > 3) {
      throw new Error(`Visual I2I input aspect ratio exceeds 3:1: ${imagePath}`)
    }
    return image
  }

  private isMultiInputValidationError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /invalid|illegal|parameter|param|argument|binary_data_base64|image/i.test(message)
  }

  private shouldRetryI2IWithSingleInput(error: unknown, params: GenerateImageParams): boolean {
    const inputCount = params.productImagePaths.length + (params.referenceImagePaths?.length ?? 0)
    return inputCount > 1 && this.isMultiInputValidationError(error)
  }

  private pickSingleInputPaths(params: GenerateImageParams): {
    productImagePaths: string[]
    referenceImagePaths: string[]
  } {
    if (params.productImagePaths.length > 0) {
      return {
        productImagePaths: [params.productImagePaths[0]],
        referenceImagePaths: [],
      }
    }
    if ((params.referenceImagePaths?.length ?? 0) > 0) {
      return {
        productImagePaths: [],
        referenceImagePaths: [params.referenceImagePaths![0]],
      }
    }
    throw new Error('Visual I2I requires at least one input image')
  }

  private async encodeValidatedImageToBase64(imagePath: string): Promise<string> {
    const image = await this.loadValidatedImage(imagePath)
    return encodeJpegWithLimit(image).toString('base64')
  }

  private async buildI2IBase64Images(
    productImagePaths: string[],
    referenceImagePaths: string[],
  ): Promise<string[]> {
    const allPaths = [...productImagePaths, ...referenceImagePaths]
    if (allPaths.length === 0) {
      throw new Error('Visual I2I requires at least one input image')
    }
    return Promise.all(allPaths.map((imagePath) => this.encodeValidatedImageToBase64(imagePath)))
  }

  private async buildI2ISubmitBody(
    params: GenerateImageParams,
    fullPrompt: string,
  ): Promise<{ body: Record<string, unknown> }> {
    const productCount = params.productImagePaths.length
    const referenceCount = params.referenceImagePaths?.length ?? 0
    const base64Images = await this.buildI2IBase64Images(
      params.productImagePaths,
      params.referenceImagePaths ?? [],
    )

    return {
      body: {
        req_key: I2I_REQ_KEY,
        binary_data_base64: base64Images,
        prompt: this.buildI2IPrompt(fullPrompt, productCount, referenceCount),
        seed: I2I_DEFAULT_SEED,
        scale: I2I_DEFAULT_SCALE,
      },
    }
  }

  private async buildSingleInputI2ISubmitBody(
    params: GenerateImageParams,
    fullPrompt: string,
  ): Promise<Record<string, unknown>> {
    const picked = this.pickSingleInputPaths(params)
    const single = await this.buildI2ISubmitBody(
      {
        ...params,
        productImagePaths: picked.productImagePaths,
        referenceImagePaths:
          picked.referenceImagePaths.length > 0 ? picked.referenceImagePaths : undefined,
      },
      fullPrompt,
    )
    return single.body
  }

  private async pollResult(taskId: string, reqKey: string): Promise<{ imageUrl: string; requestId?: string }> {
    const startedAt = Date.now()
    let delayMs = 1200

    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      const result = await this.postActionWithRetry<GetResultData>('CVSync2AsyncGetResult', {
        req_key: reqKey,
        task_id: taskId,
        req_json: JSON.stringify({ return_url: true }),
      })

      const status = result.data?.status
      if (status === 'in_queue' || status === 'generating') {
        await sleep(delayMs)
        delayMs = Math.min(delayMs + 500, 4000)
        continue
      }

      if (status === 'done') {
        const url = result.data?.image_urls?.[0]
        if (url) {
          return { imageUrl: url, requestId: result.request_id }
        }
        const base64 = result.data?.binary_data_base64?.[0]
        if (base64) {
          return { imageUrl: `data:image/jpeg;base64,${base64}`, requestId: result.request_id }
        }
        throw new Error(`Task completed but no image payload returned, request_id=${result.request_id ?? 'unknown'}`)
      }

      if (status === 'not_found' || status === 'expired') {
        throw new Error(`Task status is ${status}, task_id=${taskId}`)
      }

      throw new Error(`Unknown task status: ${String(status)}`)
    }

    throw new Error(`Polling timeout (${POLL_TIMEOUT_MS}ms), task_id=${taskId}`)
  }

  private async postActionWithRetry<TData>(
    action: 'CVSync2AsyncSubmitTask' | 'CVSync2AsyncGetResult',
    body: Record<string, unknown>,
  ): Promise<VisualApiResponse<TData>> {
    const maxAttempts = 4
    let attempt = 0

    while (attempt < maxAttempts) {
      attempt += 1
      const response = await this.postAction<TData>(action, body)
      if (response.code === 10000) {
        return response
      }

      if (Number.isFinite(response.code) && isRetriableCode(response.code) && attempt < maxAttempts) {
        await sleep(500 * attempt)
        continue
      }

      throw new Error(
        `Visual API request failed: code=${response.code}, message=${response.message}, request_id=${response.request_id ?? 'unknown'}`,
      )
    }

    throw new Error(`Visual API request failed after max retries: ${action}`)
  }

  private async postAction<TData>(
    action: 'CVSync2AsyncSubmitTask' | 'CVSync2AsyncGetResult',
    body: Record<string, unknown>,
  ): Promise<VisualApiResponse<TData>> {
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new Error('Visual API missing AccessKey/SecretKey')
    }

    const query = buildCanonicalQuery({
      Action: action,
      Version: VISUAL_VERSION,
    })
    const bodyText = JSON.stringify(body)
    const bodyHash = sha256Hex(bodyText)
    const now = new Date()
    const { shortDate, longDate } = formatAmzDate(now)
    const signedHeaders = 'host;x-date;x-content-sha256;content-type'

    const canonicalHeaders = [
      `host:${VISUAL_HOST}`,
      `x-date:${longDate}`,
      `x-content-sha256:${bodyHash}`,
      'content-type:application/json',
      '',
    ].join('\n')

    const canonicalRequest = ['POST', '/', query, canonicalHeaders, signedHeaders, bodyHash].join('\n')

    const credentialScope = `${shortDate}/${VISUAL_REGION}/${VISUAL_SERVICE}/request`
    const stringToSign = ['HMAC-SHA256', longDate, credentialScope, sha256Hex(canonicalRequest)].join('\n')

    const kDate = hmacBuffer(this.secretAccessKey, shortDate)
    const kRegion = hmacBuffer(kDate, VISUAL_REGION)
    const kService = hmacBuffer(kRegion, VISUAL_SERVICE)
    const kSigning = hmacBuffer(kService, 'request')
    const signature = hmacHex(kSigning, stringToSign)

    const authorization = `HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    const url = `${VISUAL_ENDPOINT}?${query}`

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Host: VISUAL_HOST,
        'Content-Type': 'application/json',
        'X-Date': longDate,
        'X-Content-Sha256': bodyHash,
        Authorization: authorization,
      },
      body: bodyText,
    })

    const payloadText = await resp.text()
    const payload = parseVisualResponsePayload<TData>(resp.status, payloadText)
    if (resp.status === 429 && payload.code === 10000) {
      return { ...payload, code: 50430, message: 'Request Has Reached API Limit' }
    }
    return payload
  }
}
