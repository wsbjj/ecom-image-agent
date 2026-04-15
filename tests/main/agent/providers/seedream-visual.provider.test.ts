import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockMkdir,
  mockWriteFile,
  mockStat,
  mockCreateFromPath,
  mockCreateFromBitmap,
} = vi.hoisted(() => {
  function makeNativeImage(width: number, height: number) {
    return {
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      resize: (options: { width?: number; height?: number }) =>
        makeNativeImage(options.width ?? width, options.height ?? height),
      toBitmap: () => Buffer.alloc(width * height * 4, 255),
      toJPEG: () => Buffer.alloc(1024, 1),
    }
  }

  const createFromPath = vi.fn((filePath: string) => {
    if (filePath.includes('empty')) {
      return {
        isEmpty: () => true,
        getSize: () => ({ width: 0, height: 0 }),
        resize: () => makeNativeImage(0, 0),
        toBitmap: () => Buffer.alloc(0),
        toJPEG: () => Buffer.alloc(0),
      }
    }
    return makeNativeImage(1200, 800)
  })
  const createFromBitmap = vi.fn(
    (_bitmap: Buffer, options: { width: number; height: number }) =>
      makeNativeImage(options.width, options.height),
  )
  return {
    mockMkdir: vi.fn(),
    mockWriteFile: vi.fn(),
    mockStat: vi.fn(),
    mockCreateFromPath: createFromPath,
    mockCreateFromBitmap: createFromBitmap,
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/ecom-image-agent'),
  },
  nativeImage: {
    createFromPath: mockCreateFromPath,
    createFromBitmap: mockCreateFromBitmap,
  },
}))

vi.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  stat: mockStat,
}))

import {
  SeedreamVisualProvider,
  __visualSignInternal,
} from '../../../../src/main/agent/providers/seedream-visual.provider'

describe('SeedreamVisualProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMkdir.mockResolvedValue(undefined)
    mockWriteFile.mockResolvedValue(undefined)
    mockStat.mockResolvedValue({ size: 1024 * 1024 })
  })

  it('routes to I2I and submits seededit_v3.0 body when input images exist', async () => {
    const capturedBodies: Record<string, unknown>[] = []

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('Action=CVSync2AsyncSubmitTask')) {
          capturedBodies.push(JSON.parse(String(init?.body)))
          return {
            status: 200,
            text: async () =>
              JSON.stringify({
                code: 10000,
                message: 'Success',
                request_id: 'req-submit',
                data: { task_id: 'task-1' },
              }),
          }
        }
        if (url.includes('Action=CVSync2AsyncGetResult')) {
          capturedBodies.push(JSON.parse(String(init?.body)))
          return {
            status: 200,
            text: async () =>
              JSON.stringify({
                code: 10000,
                message: 'Success',
                request_id: 'req-poll',
                data: { status: 'done', image_urls: ['https://cdn.example.com/out.jpg'] },
              }),
          }
        }
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }
      }),
    )

    const provider = new SeedreamVisualProvider({
      accessKeyId: 'AK_TEST',
      secretAccessKey: 'SK_TEST',
      reqKey: 'high_aes_general_v30l_zt2i',
    })

    const result = await provider.generate({
      prompt: 'Generate a premium ad image',
      productImagePaths: ['/product-1.jpg', '/product-2.jpg'],
      referenceImagePaths: ['/ref-1.png'],
      aspectRatio: '1:1',
      style: 'minimalist',
    })

    const submitBody = capturedBodies[0]
    const pollBody = capturedBodies[1]
    expect(submitBody?.req_key).toBe('seededit_v3.0')
    expect(Array.isArray(submitBody?.binary_data_base64)).toBe(true)
    expect((submitBody?.binary_data_base64 as string[])?.length).toBe(1)
    expect(submitBody?.scale).toBe(0.5)
    expect(pollBody?.req_key).toBe('seededit_v3.0')

    expect(result.debugInfo?.providerMode).toBe('visual_official')
    expect(result.debugInfo?.visualRoute).toBe('i2i')
    expect(result.debugInfo?.usedCompositeImage).toBe(true)
    expect(result.debugInfo?.productImageCount).toBe(2)
    expect(result.debugInfo?.referenceImageCount).toBe(1)
  })

  it('keeps T2I route when no image inputs', async () => {
    const capturedBodies: Record<string, unknown>[] = []

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('Action=CVSync2AsyncSubmitTask')) {
          capturedBodies.push(JSON.parse(String(init?.body)))
          return {
            status: 200,
            text: async () =>
              JSON.stringify({
                code: 10000,
                message: 'Success',
                request_id: 'req-submit',
                data: { task_id: 'task-2' },
              }),
          }
        }
        if (url.includes('Action=CVSync2AsyncGetResult')) {
          capturedBodies.push(JSON.parse(String(init?.body)))
          return {
            status: 200,
            text: async () =>
              JSON.stringify({
                code: 10000,
                message: 'Success',
                request_id: 'req-poll',
                data: { status: 'done', image_urls: ['https://cdn.example.com/out.jpg'] },
              }),
          }
        }
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([4, 5, 6]).buffer,
        }
      }),
    )

    const provider = new SeedreamVisualProvider({
      accessKeyId: 'AK_TEST',
      secretAccessKey: 'SK_TEST',
      reqKey: 'high_aes_general_v30l_zt2i',
    })

    const result = await provider.generate({
      prompt: 'Pure text to image',
      productImagePaths: [],
      referenceImagePaths: [],
      aspectRatio: '4:3',
    })

    const submitBody = capturedBodies[0]
    const pollBody = capturedBodies[1]
    expect(submitBody?.req_key).toBe('high_aes_general_v30l_zt2i')
    expect(submitBody?.binary_data_base64).toBeUndefined()
    expect(pollBody?.req_key).toBe('high_aes_general_v30l_zt2i')
    expect(result.debugInfo?.visualRoute).toBe('t2i')
  })

  it('builds canonical query in sorted and encoded form', () => {
    const query = __visualSignInternal.buildCanonicalQuery({
      Version: '2022-08-31',
      Action: 'CV Sync',
      keyword: 'a b',
    })

    expect(query).toBe('Action=CV%20Sync&keyword=a%20b&Version=2022-08-31')
  })
})
