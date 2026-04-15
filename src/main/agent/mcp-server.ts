import { v4 as uuidv4 } from 'uuid'
import type { VLMEvalBridge } from './vlmeval-bridge'
import type { DefectAnalysis } from '../../shared/types'
import type { ImageProvider } from './providers/base'

interface GenerateImageInput {
  prompt: string
  style?: string
  aspect_ratio?: '1:1' | '4:3' | '16:9'
  product_image_paths: string[]
  reference_image_paths?: string[]
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
  description: '调用图像生成 API 生成电商精品图，返回本地绝对路径。支持传入商品白底图实现 image-to-image 生成。',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '详细图像生成提示词（英文）' },
      style: { type: 'string', description: '风格标签，如 minimalist / warm / studio' },
      aspect_ratio: { type: 'string', enum: ['1:1', '4:3', '16:9'] },
      product_image_paths: {
        type: 'array',
        items: { type: 'string' },
        description: '白底商品图本地绝对路径列表，用于 image-to-image 参考',
      },
      reference_image_paths: {
        type: 'array',
        items: { type: 'string' },
        description: '风格参考图路径列表（可选）',
      },
    },
    required: ['prompt', 'product_image_paths'],
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
  provider: ImageProvider,
): Promise<McpServer> {
  const toolHandlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>()

  toolHandlers.set('generate_image', async (rawInput: Record<string, unknown>): Promise<GenerateImageOutput> => {
    const input = rawInput as unknown as GenerateImageInput
    const result = await provider.generate({
      prompt: input.prompt,
      style: input.style,
      aspectRatio: input.aspect_ratio,
      productImagePaths: input.product_image_paths ?? [],
      referenceImagePaths: input.reference_image_paths,
    })
    return { image_path: result.imagePath, prompt_used: result.promptUsed }
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
