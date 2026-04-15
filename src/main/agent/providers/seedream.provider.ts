import OpenAI from 'openai'
import { app } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import type { ImageProvider, GenerateImageParams, GenerateImageResult } from './base'

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_MODEL = 'doubao-seedream-3-0-t2i-250415'

const ASPECT_TO_SIZE: Record<string, string> = {
  // Seedream requires at least 3,686,400 pixels.
  '1:1': '1920x1920',
  '4:3': '2304x1728',
  '16:9': '2560x1440',
}

function isUnsupportedImagesApiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /does not support this api/i.test(message)
}

export class SeedreamProvider implements ImageProvider {
  readonly name = 'seedream' as const
  private readonly client: OpenAI
  private readonly modelId: string

  constructor(options: {
    apiKey: string
    baseUrl?: string
    endpointId?: string
  }) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl ?? DEFAULT_BASE_URL,
    })
    this.modelId = options.endpointId ?? DEFAULT_MODEL
  }

  async generate(params: GenerateImageParams): Promise<GenerateImageResult> {
    const hasProductImages = params.productImagePaths.length > 0
    const size = ASPECT_TO_SIZE[params.aspectRatio ?? '1:1'] ?? '1024x1024'

    const fullPrompt = `${params.prompt}${params.style ? `, style: ${params.style}` : ''}, e-commerce product photography, high quality, commercial grade`

    let imageUrl: string

    if (hasProductImages) {
      imageUrl = await this.generateWithReference(fullPrompt, params.productImagePaths[0], size)
    } else {
      imageUrl = await this.generateTextToImage(fullPrompt, size)
    }

    const tmpDir = path.join(app.getPath('userData'), 'tmp_images')
    await fs.mkdir(tmpDir, { recursive: true })
    const imagePath = path.join(tmpDir, `${uuidv4()}.png`)

    if (imageUrl.startsWith('data:')) {
      const base64Data = imageUrl.split(',')[1]
      await fs.writeFile(imagePath, Buffer.from(base64Data, 'base64'))
    } else {
      const response = await fetch(imageUrl)
      const buffer = Buffer.from(await response.arrayBuffer())
      await fs.writeFile(imagePath, buffer)
    }

    return {
      imagePath,
      promptUsed: fullPrompt,
      debugInfo: {
        providerMode: 'openai_compat',
      },
    }
  }

  private async generateTextToImage(prompt: string, size: string): Promise<string> {
    let response: Awaited<ReturnType<typeof this.client.images.generate>>
    try {
      response = await this.client.images.generate({
        model: this.modelId,
        prompt,
        size: size as '1024x1024',
        n: 1,
        response_format: 'url',
      })
    } catch (error: unknown) {
      if (isUnsupportedImagesApiError(error)) {
        return await this.generateViaChatPrompt(prompt, size)
      }
      throw error
    }

    const data = response.data
    if (!data || data.length === 0) {
      throw new Error('Seedream 未返回图片数据')
    }

    const first = data[0]
    const url = first.url ?? first.b64_json
    if (!url) {
      throw new Error('Seedream 未返回图片数据')
    }

    if (first.b64_json) {
      return `data:image/png;base64,${first.b64_json}`
    }
    return url
  }

  private async generateViaChatPrompt(prompt: string, size: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages: [
        {
          role: 'user',
          content: `Generate one image URL for this prompt: ${prompt}. Output image size: ${size}. Return only the final image URL.`,
        },
      ],
    })

    const content = response.choices[0]?.message?.content
    if (!content) {
      throw new Error('Seedream 未返回图片结果')
    }
    const urlMatch = content.match(/https?:\/\/[^\s"]+/)
    if (!urlMatch) {
      throw new Error(`Seedream 返回内容中未找到图片 URL: ${content.slice(0, 200)}`)
    }
    return urlMatch[0]
  }

  private async generateWithReference(
    prompt: string,
    refImagePath: string,
    size: string,
  ): Promise<string> {
    const imageData = await fs.readFile(refImagePath)
    const base64 = imageData.toString('base64')
    const ext = path.extname(refImagePath).toLowerCase()
    const mimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    }
    const mime = mimeMap[ext] ?? 'image/png'
    const dataUri = `data:${mime};base64,${base64}`

    try {
      const response = await this.client.chat.completions.create({
        model: this.modelId,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: dataUri },
              },
              {
                type: 'text',
                text: `Based on this product image, generate a professional e-commerce product photo: ${prompt}. Output image size: ${size}`,
              },
            ],
          },
        ],
      })

      const content = response.choices[0]?.message?.content
      if (!content) {
        throw new Error('Seedream 图生图未返回结果')
      }

      const urlMatch = content.match(/https?:\/\/[^\s"]+/)
      if (urlMatch) return urlMatch[0]

      return await this.generateTextToImage(prompt, size)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const unsupportedImageInput = /does not support image input|cannot read\s+"?.+\.(png|jpg|jpeg|webp|gif)"?/i.test(
        message,
      )
      if (unsupportedImageInput) {
        return await this.generateTextToImage(prompt, size)
      }
      throw error
    }
  }
}
