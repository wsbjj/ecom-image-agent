import OpenAI from 'openai'
import { app } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import type { ImageProvider, GenerateImageParams, GenerateImageResult } from './base'

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_MODEL = 'doubao-seedream-3-0-t2i-250415'

const ASPECT_TO_SIZE: Record<string, string> = {
  '1:1': '1024x1024',
  '4:3': '1024x768',
  '16:9': '1280x720',
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

    return { imagePath, promptUsed: fullPrompt }
  }

  private async generateTextToImage(prompt: string, size: string): Promise<string> {
    const response = await this.client.images.generate({
      model: this.modelId,
      prompt,
      size: size as '1024x1024',
      n: 1,
      response_format: 'url',
    })

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
  }
}
