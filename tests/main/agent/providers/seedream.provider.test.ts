import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockImagesGenerate, mockChatCreate, mockMkdir, mockWriteFile, mockReadFile } = vi.hoisted(() => ({
  mockImagesGenerate: vi.fn(),
  mockChatCreate: vi.fn(),
  mockMkdir: vi.fn(),
  mockWriteFile: vi.fn(),
  mockReadFile: vi.fn(),
}))

vi.mock('openai', () => ({
  default: class MockOpenAI {
    images = { generate: mockImagesGenerate }
    chat = { completions: { create: mockChatCreate } }
  },
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/ecom-image-agent'),
  },
}))

vi.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
}))

import { SeedreamProvider } from '../../../../src/main/agent/providers/seedream.provider'

describe('SeedreamProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue(Buffer.from('fake-image'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })),
    )
  })

  it('uses all product and reference images in openai_compat image-conditioned generation', async () => {
    mockChatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: 'https://cdn.example.com/generated.jpg',
          },
        },
      ],
    })

    const provider = new SeedreamProvider({
      apiKey: 'test-key',
      endpointId: 'doubao-seedream-4-5-251128',
    })

    const result = await provider.generate({
      prompt: 'A premium product photo',
      style: 'studio',
      productImagePaths: ['/p1.jpg', '/p2.jpg'],
      referenceImagePaths: ['/r1.png', '/r2.jpg'],
      aspectRatio: '4:3',
    })

    expect(mockChatCreate).toHaveBeenCalledTimes(1)
    const firstCall = mockChatCreate.mock.calls[0]?.[0] as {
      messages: Array<{ content: Array<{ type: string }> }>
    }
    const content = firstCall.messages[0].content
    const imageParts = content.filter((part) => part.type === 'image_url')
    expect(imageParts).toHaveLength(4)

    expect(result.debugInfo?.providerMode).toBe('openai_compat')
    expect(result.debugInfo?.productImageCount).toBe(2)
    expect(result.debugInfo?.referenceImageCount).toBe(2)
  })
})
