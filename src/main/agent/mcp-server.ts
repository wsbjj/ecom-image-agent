import { v4 as uuidv4 } from 'uuid'
import type { VLMEvalBridge } from './vlmeval-bridge'
import type { DefectAnalysis, EvalRubric } from '../../shared/types'
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
  debug_info?: {
    request_id?: string
    task_id?: string
    provider_mode?: 'visual_official' | 'openai_compat'
    visual_route?: 't2i' | 'i2i'
    fallback_reason?: string
    product_image_count?: number
    reference_image_count?: number
    used_composite_image?: boolean
  }
}

interface EvaluateImageInput {
  image_path: string
  product_name: string
  context: string
  rubric: EvalRubric
  pass_threshold: number
}

interface EvaluateImageOutput {
  total_score: number
  defect_analysis: DefectAnalysis
  passed: boolean
  pass_threshold: number
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
  description: '对已生成图片按自定义评估模板进行质量评估，返回总分、分项缺陷分析以及是否达到阈值',
  inputSchema: {
    type: 'object',
    properties: {
      image_path: { type: 'string', description: 'generate_image 返回的图片绝对路径' },
      product_name: { type: 'string', description: '商品名称' },
      context: { type: 'string', description: '拍摄场景描述' },
      rubric: {
        type: 'object',
        description: '评估模板（维度、权重、分值上限、说明）',
      },
      pass_threshold: {
        type: 'number',
        description: '通过阈值（0-100）',
      },
    },
    required: ['image_path', 'product_name', 'context', 'rubric', 'pass_threshold'],
  },
}

export async function createMcpServer(
  vlmBridge: VLMEvalBridge,
  provider: ImageProvider,
): Promise<McpServer> {
  const toolHandlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>()

  const normalizePathList = (paths: unknown): string[] =>
    Array.isArray(paths)
      ? paths
          .filter((p): p is string => typeof p === 'string')
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
      : []

  toolHandlers.set('generate_image', async (rawInput: Record<string, unknown>): Promise<GenerateImageOutput> => {
    const input = rawInput as unknown as GenerateImageInput
    const productImagePaths = normalizePathList(input.product_image_paths)
    const referenceImagePaths = normalizePathList(input.reference_image_paths)
    const result = await provider.generate({
      prompt: input.prompt,
      style: input.style,
      aspectRatio: input.aspect_ratio,
      productImagePaths,
      referenceImagePaths: referenceImagePaths.length > 0 ? referenceImagePaths : undefined,
    })
    return {
      image_path: result.imagePath,
      prompt_used: result.promptUsed,
      debug_info: result.debugInfo
        ? {
            request_id: result.debugInfo.requestId,
            task_id: result.debugInfo.taskId,
            provider_mode: result.debugInfo.providerMode,
            visual_route: result.debugInfo.visualRoute,
            fallback_reason: result.debugInfo.fallbackReason,
            product_image_count: result.debugInfo.productImageCount,
            reference_image_count: result.debugInfo.referenceImageCount,
            used_composite_image: result.debugInfo.usedCompositeImage,
          }
        : undefined,
    }
  })

  toolHandlers.set('evaluate_image', async (rawInput: Record<string, unknown>): Promise<EvaluateImageOutput> => {
    const input = rawInput as unknown as EvaluateImageInput
    const evalResult = await vlmBridge.evaluate({
      requestId: uuidv4(),
      imagePath: input.image_path,
      productName: input.product_name,
      context: input.context,
      rubric: input.rubric,
      passThreshold: Math.min(100, Math.max(0, Math.floor(input.pass_threshold))),
    })
    return {
      total_score: evalResult.totalScore,
      defect_analysis: evalResult.defectAnalysis,
      passed: evalResult.passed,
      pass_threshold: evalResult.passThreshold,
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
