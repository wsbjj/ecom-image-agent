import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DefectAnalysis, EvalRubric } from '../../../src/shared/types'
import type { ImageProvider } from '../../../src/main/agent/providers/base'

const { mockUnlink } = vi.hoisted(() => ({
  mockUnlink: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  unlink: mockUnlink,
}))

import { createMcpServer } from '../../../src/main/agent/mcp-server'

function createRubric(): EvalRubric {
  return {
    dimensions: [
      {
        key: 'overall',
        name: 'Overall',
        maxScore: 100,
        weight: 1,
        description: 'overall score',
      },
    ],
  }
}

function createDefect(): DefectAnalysis {
  return {
    dimensions: [],
    overall_recommendation: 'ok',
  }
}

describe('createMcpServer generate_image', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUnlink.mockResolvedValue(undefined)
  })

  it('runs visual multi-candidate selection and picks top score under cap=4', async () => {
    const scoreByPath: Record<string, number> = {
      '/tmp/p1_r1.png': 60,
      '/tmp/p1_r2.png': 72,
      '/tmp/p2_r1.png': 88,
      '/tmp/p2_r2.png': 95,
    }

    const provider: ImageProvider = {
      name: 'seedream-visual',
      generate: vi.fn(async (params) => {
        const p = params.productImagePaths[0] ?? 'none'
        const r = params.referenceImagePaths?.[0] ?? 'none'
        return {
          imagePath: `/tmp/${p}_${r}.png`,
          promptUsed: params.prompt,
          debugInfo: {
            providerMode: 'visual_official',
            visualRoute: 'i2i',
            usedCompositeImage: false,
          },
        }
      }),
    }

    const vlmBridge = {
      evaluate: vi.fn(async (req: { imagePath: string }) => ({
        totalScore: scoreByPath[req.imagePath] ?? 0,
        defectAnalysis: createDefect(),
        passed: true,
        passThreshold: 85,
      })),
    }

    const mcp = await createMcpServer(vlmBridge as never, provider)
    const output = (await mcp.callTool('generate_image', {
      prompt: 'make ad image',
      product_image_paths: ['p1', 'p2', 'p3'],
      reference_image_paths: ['r1', 'r2'],
      product_name: 'Bottle',
      context: 'studio',
      rubric: createRubric(),
      pass_threshold: 90,
    })) as {
      image_path: string
      debug_info?: {
        candidate_total_count?: number
        candidate_attempted_count?: number
        candidate_succeeded_count?: number
        selected_candidate_index?: number
        selected_candidate_score?: number
      }
    }

    expect(provider.generate).toHaveBeenCalledTimes(4)
    expect(provider.generate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        productImagePaths: ['p1'],
        referenceImagePaths: ['r1'],
      }),
    )
    expect(provider.generate).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        productImagePaths: ['p2'],
        referenceImagePaths: ['r2'],
      }),
    )
    expect(vlmBridge.evaluate).toHaveBeenCalledTimes(4)

    expect(output.image_path).toBe('/tmp/p2_r2.png')
    expect(output.debug_info?.candidate_total_count).toBe(4)
    expect(output.debug_info?.candidate_attempted_count).toBe(4)
    expect(output.debug_info?.candidate_succeeded_count).toBe(4)
    expect(output.debug_info?.selected_candidate_index).toBe(3)
    expect(output.debug_info?.selected_candidate_score).toBe(95)

    expect(mockUnlink).toHaveBeenCalledTimes(3)
    expect(mockUnlink).not.toHaveBeenCalledWith('/tmp/p2_r2.png')
  })

  it('skips failed candidates and still returns best successful candidate', async () => {
    const provider: ImageProvider = {
      name: 'seedream-visual',
      generate: vi
        .fn()
        .mockRejectedValueOnce(new Error('candidate 1 generate failed'))
        .mockResolvedValueOnce({
          imagePath: '/tmp/p1_r2.png',
          promptUsed: 'x',
          debugInfo: { providerMode: 'visual_official', visualRoute: 'i2i' },
        })
        .mockResolvedValueOnce({
          imagePath: '/tmp/p2_r1.png',
          promptUsed: 'x',
          debugInfo: { providerMode: 'visual_official', visualRoute: 'i2i' },
        })
        .mockResolvedValueOnce({
          imagePath: '/tmp/p2_r2.png',
          promptUsed: 'x',
          debugInfo: { providerMode: 'visual_official', visualRoute: 'i2i' },
        }),
    }

    const vlmBridge = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          totalScore: 70,
          defectAnalysis: createDefect(),
          passed: true,
          passThreshold: 85,
        })
        .mockRejectedValueOnce(new Error('candidate 3 evaluate failed'))
        .mockResolvedValueOnce({
          totalScore: 92,
          defectAnalysis: createDefect(),
          passed: true,
          passThreshold: 85,
        }),
    }

    const mcp = await createMcpServer(vlmBridge as never, provider)
    const output = (await mcp.callTool('generate_image', {
      prompt: 'make ad image',
      product_image_paths: ['p1', 'p2'],
      reference_image_paths: ['r1', 'r2'],
      product_name: 'Bottle',
      context: 'studio',
      rubric: createRubric(),
      pass_threshold: 90,
    })) as {
      image_path: string
      debug_info?: { candidate_attempted_count?: number; candidate_succeeded_count?: number }
    }

    expect(output.image_path).toBe('/tmp/p2_r2.png')
    expect(output.debug_info?.candidate_attempted_count).toBe(4)
    expect(output.debug_info?.candidate_succeeded_count).toBe(2)
  })

  it('throws aggregated error when all visual candidates fail', async () => {
    const provider: ImageProvider = {
      name: 'seedream-visual',
      generate: vi.fn(async () => {
        throw new Error('upstream unavailable')
      }),
    }

    const vlmBridge = {
      evaluate: vi.fn(),
    }

    const mcp = await createMcpServer(vlmBridge as never, provider)
    await expect(
      mcp.callTool('generate_image', {
        prompt: 'make ad image',
        product_image_paths: ['p1', 'p2'],
        reference_image_paths: ['r1', 'r2'],
        product_name: 'Bottle',
        context: 'studio',
        rubric: createRubric(),
        pass_threshold: 90,
      }),
    ).rejects.toThrow(/all 4 visual candidates failed/i)
  })

  it('falls back to single provider.generate call when eval context fields are missing', async () => {
    const provider: ImageProvider = {
      name: 'seedream-visual',
      generate: vi.fn(async () => ({
        imagePath: '/tmp/single.png',
        promptUsed: 'single',
      })),
    }

    const vlmBridge = {
      evaluate: vi.fn(),
    }

    const mcp = await createMcpServer(vlmBridge as never, provider)
    const output = (await mcp.callTool('generate_image', {
      prompt: 'make ad image',
      product_image_paths: ['p1', 'p2'],
      reference_image_paths: ['r1', 'r2'],
    })) as { image_path: string }

    expect(output.image_path).toBe('/tmp/single.png')
    expect(provider.generate).toHaveBeenCalledTimes(1)
    expect(provider.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        productImagePaths: ['p1', 'p2'],
        referenceImagePaths: ['r1', 'r2'],
      }),
    )
    expect(vlmBridge.evaluate).not.toHaveBeenCalled()
  })
})
