import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGenerateContent, mockReadFile, mockMkdir, mockWriteFile } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
  mockReadFile: vi.fn(),
  mockMkdir: vi.fn(),
  mockWriteFile: vi.fn(),
}))

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class MockGoogleGenerativeAI {
    getGenerativeModel() {
      return {
        generateContent: mockGenerateContent,
      }
    }
  },
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/ecom-image-agent'),
  },
}))

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
}))

import { GeminiProvider } from '../../../../src/main/agent/providers/gemini.provider'

describe('GeminiProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    mockReadFile.mockImplementation(async (filePath: string) => Buffer.from(filePath))
    mockGenerateContent.mockResolvedValue({
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: Buffer.from('generated-image').toString('base64'),
                  },
                },
              ],
            },
          },
        ],
      },
    })
  })

  it('consumes product images, reference images and prompt together in fixed order', async () => {
    const provider = new GeminiProvider({ apiKey: 'test-key' })

    const result = await provider.generate({
      prompt: 'Premium cosmetic ad shot',
      style: 'minimalist',
      aspectRatio: '4:3',
      productImagePaths: ['/p1.jpg', '/p2.png'],
      referenceImagePaths: ['/r1.jpg'],
    })

    expect(mockGenerateContent).toHaveBeenCalledTimes(1)
    const payload = mockGenerateContent.mock.calls[0]?.[0] as {
      contents: Array<{ role: string; parts: Array<{ text?: string; inlineData?: { data: string } }> }>
    }
    const parts = payload.contents[0].parts
    expect(parts).toHaveLength(4)

    expect(parts[0]?.inlineData?.data).toBe(Buffer.from('/p1.jpg').toString('base64'))
    expect(parts[1]?.inlineData?.data).toBe(Buffer.from('/p2.png').toString('base64'))
    expect(parts[2]?.inlineData?.data).toBe(Buffer.from('/r1.jpg').toString('base64'))
    expect(parts[3]?.text).toContain('Use all 2 product images as the primary source')
    expect(parts[3]?.text).toContain('Use all 1 reference images only for style')
    expect(parts[3]?.text).toContain('target aspect ratio 4:3')

    expect(result.debugInfo?.productImageCount).toBe(2)
    expect(result.debugInfo?.referenceImageCount).toBe(1)
  })
})
