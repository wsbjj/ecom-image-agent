import { GoogleGenerativeAI, type GenerateContentResult } from '@google/generative-ai'
import { app } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import type { VLMEvalBridge } from './vlmeval-bridge'
import type { DefectAnalysis } from '../../shared/types'

interface GenerateImageInput {
  prompt: string
  style?: string
  aspect_ratio?: '1:1' | '4:3' | '16:9'
}

interface GenerateImageOutput {
  image_path: string
  prompt_used: string
}

interface EvaluateImageInput {
  image_path: string
  product_name: string
  context: string
}

interface EvaluateImageOutput {
  total_score: number
  defect_analysis: DefectAnalysis
}

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpServer {
  tools: McpToolDefinition[]
  callTool: (name: string, input: Record<string, unknown>) => Promise<unknown>
}

const GENERATE_IMAGE_TOOL: McpToolDefinition = {
  name: 'generate_image',
  description: '调用 Google Gemini API 生成电商精品图，返回本地绝对路径',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '详细图像生成提示词（英文）' },
      style: { type: 'string', description: '风格标签，如 minimalist / warm / studio' },
      aspect_ratio: { type: 'string', enum: ['1:1', '4:3', '16:9'] },
    },
    required: ['prompt'],
  },
}

const EVALUATE_IMAGE_TOOL: McpToolDefinition = {
  name: 'evaluate_image',
  description: '对已生成的图片进行三维度质量评估（边缘畸变/透视光影/幻觉物体），返回评分和缺陷分析',
  inputSchema: {
    type: 'object',
    properties: {
      image_path: { type: 'string', description: 'generate_image 返回的图片绝对路径' },
      product_name: { type: 'string', description: '商品名称' },
      context: { type: 'string', description: '拍摄场景描述' },
    },
    required: ['image_path', 'product_name', 'context'],
  },
}

export async function createMcpServer(
  vlmBridge: VLMEvalBridge,
  options: { googleApiKey: string; googleBaseUrl?: string; googleImageModel?: string },
): Promise<McpServer> {
  const genAI = new GoogleGenerativeAI(options.googleApiKey)

  const toolHandlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>()

  toolHandlers.set('generate_image', async (rawInput: Record<string, unknown>): Promise<GenerateImageOutput> => {
    const input = rawInput as unknown as GenerateImageInput
    const model = genAI.getGenerativeModel(
      { model: options.googleImageModel ?? 'gemini-2.0-flash-preview-image-generation' },
      options.googleBaseUrl ? { baseUrl: options.googleBaseUrl } : undefined,
    )
    const fullPrompt = `${input.prompt}${input.style ? `, style: ${input.style}` : ''}, product photography, white background, 8K, commercial quality`

    const result: GenerateContentResult = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
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

    return { image_path: imagePath, prompt_used: fullPrompt }
  })

  toolHandlers.set('evaluate_image', async (rawInput: Record<string, unknown>): Promise<EvaluateImageOutput> => {
    const input = rawInput as unknown as EvaluateImageInput
    const evalResult = await vlmBridge.evaluate({
      requestId: uuidv4(),
      imagePath: input.image_path,
      productName: input.product_name,
      context: input.context,
    })
    return {
      total_score: evalResult.totalScore,
      defect_analysis: evalResult.defectAnalysis,
    }
  })

  return {
    tools: [GENERATE_IMAGE_TOOL, EVALUATE_IMAGE_TOOL],
    callTool: async (name: string, input: Record<string, unknown>): Promise<unknown> => {
      const handler = toolHandlers.get(name)
      if (!handler) {
        throw new Error(`Unknown tool: ${name}`)
      }
      return handler(input)
    },
  }
}
