import { v4 as uuidv4 } from 'uuid'
import * as fs from 'node:fs/promises'
import type { VLMEvalBridge } from './vlmeval-bridge'
import type { DefectAnalysis, EvalRubric } from '../../shared/types'
import type { GenerateImageResult, ImageProvider } from './providers/base'

const MULTI_CANDIDATE_CAP = 4
const VISUAL_PROVIDER_NAME = 'seedream-visual'

interface GenerateImageInput {
  prompt: string
  style?: string
  aspect_ratio?: '1:1' | '4:3' | '16:9'
  product_image_paths: string[]
  reference_image_paths?: string[]
  product_name?: string
  context?: string
  rubric?: EvalRubric
  pass_threshold?: number
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
    candidate_total_count?: number
    candidate_attempted_count?: number
    candidate_succeeded_count?: number
    selected_candidate_index?: number
    selected_candidate_score?: number
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

interface MultiCandidateEvalContext {
  productName: string
  context: string
  rubric: EvalRubric
  passThreshold: number
}

interface ImageCandidate {
  productImagePaths: string[]
  referenceImagePaths?: string[]
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
  description:
    'Call image generation API and return local absolute file path. Supports product and reference images.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed prompt text for image generation.' },
      style: { type: 'string', description: 'Style tag, such as minimalist / warm / studio.' },
      aspect_ratio: { type: 'string', enum: ['1:1', '4:3', '16:9'] },
      product_image_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Absolute paths of product images for image-conditioned generation.',
      },
      reference_image_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional absolute paths of style reference images.',
      },
      product_name: {
        type: 'string',
        description: 'Optional product name used by internal multi-candidate evaluation.',
      },
      context: {
        type: 'string',
        description: 'Optional scene context used by internal multi-candidate evaluation.',
      },
      rubric: {
        type: 'object',
        description: 'Optional evaluation rubric used by internal multi-candidate evaluation.',
      },
      pass_threshold: {
        type: 'number',
        description: 'Optional threshold used by internal multi-candidate evaluation.',
      },
    },
    required: ['prompt', 'product_image_paths'],
  },
}

const EVALUATE_IMAGE_TOOL: McpToolDefinition = {
  name: 'evaluate_image',
  description:
    'Evaluate generated image quality using rubric and return total score, defect analysis, and pass result.',
  inputSchema: {
    type: 'object',
    properties: {
      image_path: { type: 'string', description: 'Absolute image path returned by generate_image.' },
      product_name: { type: 'string', description: 'Product name.' },
      context: { type: 'string', description: 'Scene context.' },
      rubric: { type: 'object', description: 'Evaluation rubric definition.' },
      pass_threshold: { type: 'number', description: 'Pass threshold in range 0-100.' },
    },
    required: ['image_path', 'product_name', 'context', 'rubric', 'pass_threshold'],
  },
}

function normalizePathList(paths: unknown): string[] {
  if (!Array.isArray(paths)) return []
  return paths
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function toGenerateOutput(result: GenerateImageResult): GenerateImageOutput {
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
          candidate_total_count: result.debugInfo.candidateTotalCount,
          candidate_attempted_count: result.debugInfo.candidateAttemptedCount,
          candidate_succeeded_count: result.debugInfo.candidateSucceededCount,
          selected_candidate_index: result.debugInfo.selectedCandidateIndex,
          selected_candidate_score: result.debugInfo.selectedCandidateScore,
        }
      : undefined,
  }
}

function parseMultiCandidateEvalContext(input: GenerateImageInput): MultiCandidateEvalContext | null {
  const productName = input.product_name?.trim()
  const context = input.context?.trim()
  const rubric = input.rubric
  if (!productName || !context || !rubric || !Array.isArray(rubric.dimensions)) {
    return null
  }

  const rawThreshold =
    typeof input.pass_threshold === 'number' && Number.isFinite(input.pass_threshold)
      ? input.pass_threshold
      : 85

  return {
    productName,
    context,
    rubric,
    passThreshold: Math.min(100, Math.max(0, Math.floor(rawThreshold))),
  }
}

function buildVisualCandidates(
  productImagePaths: string[],
  referenceImagePaths: string[],
): ImageCandidate[] {
  const candidates: ImageCandidate[] = []

  if (productImagePaths.length === 0) {
    for (const referenceImagePath of referenceImagePaths) {
      candidates.push({
        productImagePaths: [],
        referenceImagePaths: [referenceImagePath],
      })
    }
    return candidates.slice(0, MULTI_CANDIDATE_CAP)
  }

  if (referenceImagePaths.length > 0) {
    for (const productImagePath of productImagePaths) {
      for (const referenceImagePath of referenceImagePaths) {
        candidates.push({
          productImagePaths: [productImagePath],
          referenceImagePaths: [referenceImagePath],
        })
      }
    }
    return candidates.slice(0, MULTI_CANDIDATE_CAP)
  }

  for (const productImagePath of productImagePaths) {
    candidates.push({
      productImagePaths: [productImagePath],
      referenceImagePaths: undefined,
    })
  }
  return candidates.slice(0, MULTI_CANDIDATE_CAP)
}

function shouldUseVisualCandidateSelection(
  provider: ImageProvider,
  totalInputImages: number,
  evalContext: MultiCandidateEvalContext | null,
): boolean {
  return provider.name === VISUAL_PROVIDER_NAME && totalInputImages > 1 && evalContext !== null
}

export async function createMcpServer(
  vlmBridge: VLMEvalBridge,
  provider: ImageProvider,
): Promise<McpServer> {
  const toolHandlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>()

  toolHandlers.set('generate_image', async (rawInput: Record<string, unknown>): Promise<GenerateImageOutput> => {
    const input = rawInput as unknown as GenerateImageInput
    const productImagePaths = normalizePathList(input.product_image_paths)
    const referenceImagePaths = normalizePathList(input.reference_image_paths)

    const evalContext = parseMultiCandidateEvalContext(input)
    const totalInputImages = productImagePaths.length + referenceImagePaths.length
    const useCandidateSelection = shouldUseVisualCandidateSelection(provider, totalInputImages, evalContext)

    if (!useCandidateSelection) {
      const result = await provider.generate({
        prompt: input.prompt,
        style: input.style,
        aspectRatio: input.aspect_ratio,
        productImagePaths,
        referenceImagePaths: referenceImagePaths.length > 0 ? referenceImagePaths : undefined,
      })
      return toGenerateOutput(result)
    }

    const candidates = buildVisualCandidates(productImagePaths, referenceImagePaths)
    if (candidates.length === 0) {
      const result = await provider.generate({
        prompt: input.prompt,
        style: input.style,
        aspectRatio: input.aspect_ratio,
        productImagePaths,
        referenceImagePaths: referenceImagePaths.length > 0 ? referenceImagePaths : undefined,
      })
      return toGenerateOutput(result)
    }

    const failedReasons: string[] = []
    const successfulGenerations: Array<{ candidateIndex: number; result: GenerateImageResult; score: number }> = []
    let attemptedCount = 0
    let succeededCount = 0

    for (const [candidateIndex, candidate] of candidates.entries()) {
      attemptedCount += 1
      try {
        const generated = await provider.generate({
          prompt: input.prompt,
          style: input.style,
          aspectRatio: input.aspect_ratio,
          productImagePaths: candidate.productImagePaths,
          referenceImagePaths: candidate.referenceImagePaths,
        })

        const evalResult = await vlmBridge.evaluate({
          requestId: uuidv4(),
          imagePath: generated.imagePath,
          productName: evalContext!.productName,
          context: evalContext!.context,
          rubric: evalContext!.rubric,
          passThreshold: evalContext!.passThreshold,
        })

        succeededCount += 1
        successfulGenerations.push({
          candidateIndex,
          result: generated,
          score: evalResult.totalScore,
        })
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error)
        failedReasons.push(`candidate_${candidateIndex + 1}: ${reason}`)
      }
    }

    if (successfulGenerations.length === 0) {
      const sampled = failedReasons.slice(0, 3).join(' | ')
      throw new Error(
        `all ${attemptedCount} visual candidates failed${sampled ? `: ${sampled}` : ''}`,
      )
    }

    let best = successfulGenerations[0]
    for (let i = 1; i < successfulGenerations.length; i += 1) {
      if (successfulGenerations[i].score > best.score) {
        best = successfulGenerations[i]
      }
    }

    const cleanupTargets = successfulGenerations
      .filter((item) => item.result.imagePath !== best.result.imagePath)
      .map((item) => item.result.imagePath)
    await Promise.allSettled(cleanupTargets.map(async (imagePath) => fs.unlink(imagePath)))

    const mergedResult: GenerateImageResult = {
      ...best.result,
      debugInfo: {
        ...best.result.debugInfo,
        productImageCount: productImagePaths.length,
        referenceImageCount: referenceImagePaths.length,
        usedCompositeImage: false,
        candidateTotalCount: candidates.length,
        candidateAttemptedCount: attemptedCount,
        candidateSucceededCount: succeededCount,
        selectedCandidateIndex: best.candidateIndex,
        selectedCandidateScore: best.score,
      },
    }

    return toGenerateOutput(mergedResult)
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
