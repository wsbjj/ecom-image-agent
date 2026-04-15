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
const MIN_COMPOSITE_SIDE = 512
const MAX_COMPOSITE_SIDE = 1536
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
    longDate: iso.slice(0, 15) + 'Z',
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
      message: `Visual API 返回非 JSON 响应: ${payloadText.slice(0, 200)}`,
      data: null,
    }
  }

  if (typeof payload !== 'object' || payload === null) {
    return {
      code: httpStatus,
      message: `Visual API 返回了无效响应结构: ${String(payload).slice(0, 200)}`,
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
    message: `Visual API 返回未知结构: ${payloadText.slice(0, 200)}`,
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

function blitBitmap(
  target: Buffer,
  targetWidth: number,
  targetHeight: number,
  source: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  offsetX: number,
  offsetY: number,
): void {
  for (let y = 0; y < sourceHeight; y += 1) {
    const destY = y + offsetY
    if (destY < 0 || destY >= targetHeight) continue
    for (let x = 0; x < sourceWidth; x += 1) {
      const destX = x + offsetX
      if (destX < 0 || destX >= targetWidth) continue
      const srcIndex = (y * sourceWidth + x) * 4
      const dstIndex = (destY * targetWidth + destX) * 4
      target[dstIndex] = source[srcIndex]
      target[dstIndex + 1] = source[srcIndex + 1]
      target[dstIndex + 2] = source[srcIndex + 2]
      target[dstIndex + 3] = source[srcIndex + 3]
    }
  }
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
    const nextWidth = Math.max(MIN_COMPOSITE_SIDE, Math.floor(size.width * 0.85))
    const nextHeight = Math.max(MIN_COMPOSITE_SIDE, Math.floor(size.height * 0.85))
    if (nextWidth === size.width && nextHeight === size.height) {
      break
    }
    working = working.resize({ width: nextWidth, height: nextHeight, quality: 'good' })
  }
  throw new Error('I2I 输入图压缩失败：无法将合成图控制在 5MB 以内')
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
      return this.callFallback(params, '官方 Visual 缺少 AccessKey/SecretKey')
    }

    const productCount = params.productImagePaths.length
    const referenceCount = params.referenceImagePaths?.length ?? 0
    const hasInputImages = productCount + referenceCount > 0

    const size = ASPECT_TO_SIZE[params.aspectRatio ?? '1:1'] ?? ASPECT_TO_SIZE['1:1']
    const fullPrompt = `${params.prompt}${params.style ? `, style: ${params.style}` : ''}, e-commerce product photography, high quality, commercial grade`

    try {
      const visualRoute: 't2i' | 'i2i' = hasInputImages ? 'i2i' : 't2i'
      let submitBody: Record<string, unknown>
      let usedCompositeImage = false
      if (visualRoute === 'i2i') {
        const i2i = await this.buildI2ISubmitBody(params, fullPrompt)
        submitBody = i2i.body
        usedCompositeImage = i2i.usedCompositeImage
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

      const submit = await this.postActionWithRetry<SubmitTaskData>('CVSync2AsyncSubmitTask', submitBody)

      const taskId = submit.data?.task_id
      if (!taskId) {
        throw new Error(`提交任务成功但未返回 task_id，request_id=${submit.request_id ?? 'unknown'}`)
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
          throw new Error(`下载生成图片失败: HTTP ${response.status}`)
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
          productImageCount: productCount,
          referenceImageCount: referenceCount,
          usedCompositeImage,
        },
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (isAuthLikeError(message)) {
        throw new Error(`官方 Visual 鉴权失败，请检查 AK/SK 或权限配置：${message}`)
      }
      return this.callFallback(params, `官方 Visual 调用失败：${message}`)
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
      throw new Error(`${reason}；回退 openai_compat 也失败：${fallbackMessage}`)
    }
  }

  private buildI2IPrompt(
    basePrompt: string,
    productCount: number,
    referenceCount: number,
  ): string {
    return [
      `严格保持商品主体一致性（形状、材质、比例、关键细节）`,
      `商品图数量=${productCount}，参考风格图数量=${referenceCount}`,
      referenceCount > 0 ? '参考图仅用于风格、光影、色彩和构图，不改变商品主体。' : '',
      `生成目标：${basePrompt}`,
    ]
      .filter((text) => text.length > 0)
      .join('。')
  }

  private async loadValidatedImage(imagePath: string): Promise<ReturnType<typeof nativeImage.createFromPath>> {
    if (!supportedImageExt(imagePath)) {
      throw new Error(`Visual I2I 仅支持 JPG/PNG 输入: ${imagePath}`)
    }
    const stat = await fs.stat(imagePath)
    if (stat.size > MAX_I2I_INPUT_BYTES) {
      throw new Error(`Visual I2I 输入图不能超过 5MB: ${imagePath}`)
    }
    const img = nativeImage.createFromPath(imagePath)
    if (img.isEmpty()) {
      throw new Error(`无法读取图片: ${imagePath}`)
    }
    const { width, height } = img.getSize()
    if (width <= 0 || height <= 0) {
      throw new Error(`图片尺寸无效: ${imagePath}`)
    }
    if (width > MAX_I2I_INPUT_DIMENSION || height > MAX_I2I_INPUT_DIMENSION) {
      throw new Error(`Visual I2I 输入图分辨率不能超过 4096x4096: ${imagePath}`)
    }
    const ratio = Math.max(width, height) / Math.min(width, height)
    if (ratio > 3) {
      throw new Error(`Visual I2I 输入图长宽比不能超过 3:1: ${imagePath}`)
    }
    return img
  }

  private createBlankBitmap(width: number, height: number): Buffer {
    const bitmap = Buffer.alloc(width * height * 4)
    for (let i = 0; i < bitmap.length; i += 4) {
      bitmap[i] = 255
      bitmap[i + 1] = 255
      bitmap[i + 2] = 255
      bitmap[i + 3] = 255
    }
    return bitmap
  }

  private composeImages(images: ReturnType<typeof nativeImage.createFromPath>[]): ReturnType<typeof nativeImage.createFromBitmap> {
    const count = images.length
    const cols = Math.ceil(Math.sqrt(count))
    const rows = Math.ceil(count / cols)
    const cell = Math.max(
      Math.floor(MIN_COMPOSITE_SIDE / Math.max(cols, rows)),
      Math.floor(MAX_COMPOSITE_SIDE / Math.max(cols, rows)),
    )
    const width = cols * cell
    const height = rows * cell
    const bitmap = this.createBlankBitmap(width, height)

    images.forEach((img, index) => {
      const row = Math.floor(index / cols)
      const col = index % cols
      const x0 = col * cell
      const y0 = row * cell
      const { width: srcW, height: srcH } = img.getSize()
      const scale = Math.min(cell / srcW, cell / srcH)
      const targetW = Math.max(1, Math.floor(srcW * scale))
      const targetH = Math.max(1, Math.floor(srcH * scale))
      const resized = img.resize({ width: targetW, height: targetH, quality: 'good' })
      const srcBitmap = resized.toBitmap()
      const offsetX = x0 + Math.floor((cell - targetW) / 2)
      const offsetY = y0 + Math.floor((cell - targetH) / 2)
      blitBitmap(bitmap, width, height, srcBitmap, targetW, targetH, offsetX, offsetY)
    })

    return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 })
  }

  private async buildI2IBase64Image(
    productImagePaths: string[],
    referenceImagePaths: string[],
  ): Promise<{ base64: string; usedCompositeImage: boolean }> {
    const allPaths = [...productImagePaths, ...referenceImagePaths]
    if (allPaths.length === 0) {
      throw new Error('Visual I2I 至少需要 1 张输入图')
    }
    const loaded = await Promise.all(allPaths.map((imagePath) => this.loadValidatedImage(imagePath)))
    const image = loaded.length > 1 ? this.composeImages(loaded) : loaded[0]
    const encoded = encodeJpegWithLimit(image)
    return {
      base64: encoded.toString('base64'),
      usedCompositeImage: loaded.length > 1,
    }
  }

  private async buildI2ISubmitBody(
    params: GenerateImageParams,
    fullPrompt: string,
  ): Promise<{ body: Record<string, unknown>; usedCompositeImage: boolean }> {
    const productCount = params.productImagePaths.length
    const referenceCount = params.referenceImagePaths?.length ?? 0
    const { base64, usedCompositeImage } = await this.buildI2IBase64Image(
      params.productImagePaths,
      params.referenceImagePaths ?? [],
    )
    return {
      body: {
        req_key: I2I_REQ_KEY,
        binary_data_base64: [base64],
        prompt: this.buildI2IPrompt(fullPrompt, productCount, referenceCount),
        seed: I2I_DEFAULT_SEED,
        scale: I2I_DEFAULT_SCALE,
      },
      usedCompositeImage,
    }
  }

  private async pollResult(taskId: string, reqKey: string): Promise<{ imageUrl: string; requestId?: string }> {
    const startedAt = Date.now()
    let delayMs = 1200

    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      const result = await this.postActionWithRetry<GetResultData>(
        'CVSync2AsyncGetResult',
        {
          req_key: reqKey,
          task_id: taskId,
          req_json: JSON.stringify({ return_url: true }),
        },
      )

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
        throw new Error(`任务已完成但未返回图片，request_id=${result.request_id ?? 'unknown'}`)
      }

      if (status === 'not_found' || status === 'expired') {
        throw new Error(`任务状态异常: ${status}, task_id=${taskId}`)
      }

      throw new Error(`未知任务状态: ${String(status)}`)
    }

    throw new Error(`任务轮询超时 (${POLL_TIMEOUT_MS}ms), task_id=${taskId}`)
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
        `Visual API 调用失败: code=${response.code}, message=${response.message}, request_id=${response.request_id ?? 'unknown'}`,
      )
    }

    throw new Error(`Visual API 调用失败，超过最大重试次数: ${action}`)
  }

  private async postAction<TData>(
    action: 'CVSync2AsyncSubmitTask' | 'CVSync2AsyncGetResult',
    body: Record<string, unknown>,
  ): Promise<VisualApiResponse<TData>> {
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new Error('Visual API 缺少 AccessKey/SecretKey')
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

    const canonicalRequest = [
      'POST',
      '/',
      query,
      canonicalHeaders,
      signedHeaders,
      bodyHash,
    ].join('\n')

    const credentialScope = `${shortDate}/${VISUAL_REGION}/${VISUAL_SERVICE}/request`
    const stringToSign = [
      'HMAC-SHA256',
      longDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n')

    // Volcengine Signature V4 uses raw secret key for the date key derivation.
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
