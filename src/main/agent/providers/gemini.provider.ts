import { GoogleGenerativeAI, type GenerateContentResult } from '@google/generative-ai'
import { app } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import type { ImageProvider, GenerateImageParams, GenerateImageResult } from './base'

function mimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }
  return map[ext] ?? 'image/png'
}

export class GeminiProvider implements ImageProvider {
  readonly name = 'gemini' as const
  private readonly genAI: GoogleGenerativeAI
  private readonly baseUrl?: string
  private readonly imageModel: string

  constructor(options: {
    apiKey: string
    baseUrl?: string
    imageModel?: string
  }) {
    this.genAI = new GoogleGenerativeAI(options.apiKey)
    this.baseUrl = options.baseUrl
    this.imageModel = options.imageModel ?? 'gemini-2.0-flash-preview-image-generation'
  }

  async generate(params: GenerateImageParams): Promise<GenerateImageResult> {
    const model = this.genAI.getGenerativeModel(
      { model: this.imageModel },
      this.baseUrl ? { baseUrl: this.baseUrl } : undefined,
    )

    const fullPrompt = `${params.prompt}${params.style ? `, style: ${params.style}` : ''}, product photography, white background, 8K, commercial quality`

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = []

    for (const imgPath of params.productImagePaths) {
      const data = await fs.readFile(imgPath)
      parts.push({
        inlineData: {
          mimeType: mimeTypeFromPath(imgPath),
          data: data.toString('base64'),
        },
      })
    }

    if (params.referenceImagePaths) {
      for (const imgPath of params.referenceImagePaths) {
        const data = await fs.readFile(imgPath)
        parts.push({
          inlineData: {
            mimeType: mimeTypeFromPath(imgPath),
            data: data.toString('base64'),
          },
        })
      }
    }

    parts.push({ text: fullPrompt })

    const result: GenerateContentResult = await model.generateContent({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'image/png',
      },
    })

    const candidates = result.response.candidates
    const imagePart = candidates?.[0]?.content.parts.find(
      (p) => p.inlineData?.mimeType?.startsWith('image/'),
    )
    if (!imagePart?.inlineData?.data) {
      throw new Error('Gemini 未返回图片数据')
    }

    const tmpDir = path.join(app.getPath('userData'), 'tmp_images')
    await fs.mkdir(tmpDir, { recursive: true })
    const imagePath = path.join(tmpDir, `${uuidv4()}.png`)
    await fs.writeFile(imagePath, Buffer.from(imagePart.inlineData.data, 'base64'))

    return { imagePath, promptUsed: fullPrompt }
  }
}
