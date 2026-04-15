import { app } from 'electron'
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
const DEFAULT_REQ_KEY = 'high_aes_general_v30l_zt2i'
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
    this.reqKey = options.reqKey?.trim() || DEFAULT_REQ_KEY
    this.fallbackProvider = options.fallbackProvider
  }

  async generate(params: GenerateImageParams): Promise<GenerateImageResult> {
    if (!this.accessKeyId || !this.secretAccessKey) {
      return this.callFallback(params, '官方 Visual 缺少 AccessKey/SecretKey')
    }

    const size = ASPECT_TO_SIZE[params.aspectRatio ?? '1:1'] ?? ASPECT_TO_SIZE['1:1']
    const fullPrompt = `${params.prompt}${params.style ? `, style: ${params.style}` : ''}, e-commerce product photography, high quality, commercial grade`

    try {
      const submit = await this.postActionWithRetry<SubmitTaskData>(
        'CVSync2AsyncSubmitTask',
        {
          req_key: this.reqKey,
          prompt: fullPrompt,
          use_pre_llm: false,
          seed: -1,
          width: size.width,
          height: size.height,
        },
      )

      const taskId = submit.data?.task_id
      if (!taskId) {
        throw new Error(`提交任务成功但未返回 task_id，request_id=${submit.request_id ?? 'unknown'}`)
      }

      const result = await this.pollResult(taskId)
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

  private async pollResult(taskId: string): Promise<{ imageUrl: string; requestId?: string }> {
    const startedAt = Date.now()
    let delayMs = 1200

    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      const result = await this.postActionWithRetry<GetResultData>(
        'CVSync2AsyncGetResult',
        {
          req_key: this.reqKey,
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
          return { imageUrl: `data:image/png;base64,${base64}`, requestId: result.request_id }
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

    const query = `Action=${action}&Version=${VISUAL_VERSION}`
    const bodyText = JSON.stringify(body)
    const bodyHash = sha256Hex(bodyText)
    const now = new Date()
    const { shortDate, longDate } = formatAmzDate(now)
    const signedHeaders = 'content-type;host;x-content-sha256;x-date'

    const canonicalHeaders = [
      'content-type:application/json',
      `host:${VISUAL_HOST}`,
      `x-content-sha256:${bodyHash}`,
      `x-date:${longDate}`,
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
