import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSpawn, mockSpawnSync } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockSpawnSync: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => '/tmp/ecom-image-agent'),
    getPath: vi.fn(() => '/tmp/ecom-image-agent-user-data'),
  },
}))

vi.mock('node:child_process', () => ({
  default: {
    spawn: mockSpawn,
    spawnSync: mockSpawnSync,
  },
  spawn: mockSpawn,
  spawnSync: mockSpawnSync,
}))

import { VLMEvalBridge } from '../../../src/main/agent/vlmeval-bridge'

type BridgeInternals = {
  handleStderrChunk: (chunk: Buffer) => void
  flushStderrDecoder: () => void
}

function getInternals(bridge: VLMEvalBridge): BridgeInternals {
  return bridge as unknown as BridgeInternals
}

describe('VLMEvalBridge stderr logging', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
    })
    mockSpawn.mockImplementation(() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const emitter = new EventEmitter()
      const proc = {
        stdout,
        stderr,
        stdin: { write: vi.fn() },
        kill: vi.fn(),
        on: emitter.on.bind(emitter),
      }
      return proc
    })
  })

  it('decodes UTF-8 chunks split in the middle of multibyte chars', () => {
    const bridge = new VLMEvalBridge()
    const internals = getInternals(bridge)
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const payload = Buffer.from('使用模型: glm-5\n', 'utf8')
    internals.handleStderrChunk(payload.subarray(0, 1))
    internals.handleStderrChunk(payload.subarray(1, 5))
    internals.handleStderrChunk(payload.subarray(5))

    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy).toHaveBeenCalledWith('[VLMEval] 使用模型: glm-5\n')
  })

  it('deduplicates prefix when line already starts with [VLMEval]', () => {
    const bridge = new VLMEvalBridge()
    const internals = getInternals(bridge)
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    internals.handleStderrChunk(Buffer.from('[VLMEval] service_started status=ready\n', 'utf8'))

    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy).toHaveBeenCalledWith('[VLMEval] service_started status=ready\n')
  })

  it('emits complete lines only and flushes trailing buffered content', () => {
    const bridge = new VLMEvalBridge()
    const internals = getInternals(bridge)
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    internals.handleStderrChunk(Buffer.from('line-1\nline-2\nline', 'utf8'))
    expect(writeSpy).toHaveBeenNthCalledWith(1, '[VLMEval] line-1\n')
    expect(writeSpy).toHaveBeenNthCalledWith(2, '[VLMEval] line-2\n')

    internals.handleStderrChunk(Buffer.from('-3\ntail-without-newline', 'utf8'))
    expect(writeSpy).toHaveBeenNthCalledWith(3, '[VLMEval] line-3\n')

    internals.flushStderrDecoder()
    expect(writeSpy).toHaveBeenNthCalledWith(4, '[VLMEval] tail-without-newline\n')
    expect(writeSpy).toHaveBeenCalledTimes(4)
  })

  it('sanitizes Python UTF-8 env for dependency checks, pip install, and runtime spawn', async () => {
    const previousPythonUtf8 = process.env.PYTHONUTF8
    const previousPythonIoEncoding = process.env.PYTHONIOENCODING
    process.env.PYTHONUTF8 = 'true'
    process.env.PYTHONIOENCODING = 'latin1'

    mockSpawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })

    try {
      const bridge = new VLMEvalBridge()
      await bridge.start('python', {
        evalBackend: 'vlmevalkit',
        judgeApiKey: 'judge-key',
        judgeBaseUrl: 'https://judge.example.com',
        judgeModel: 'glm-5',
        vlmevalModelId: 'glm-registry-key',
        vlmevalUseCustomModel: true,
      })

      expect(mockSpawnSync).toHaveBeenCalledTimes(4)
      for (const call of mockSpawnSync.mock.calls) {
        const options = call[2] as { env?: NodeJS.ProcessEnv }
        expect(options.env?.PYTHONUTF8).toBe('1')
        expect(options.env?.PYTHONIOENCODING).toBe('utf-8')
      }

      expect(mockSpawn).toHaveBeenCalledTimes(1)
      const runtimeOptions = mockSpawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv }
      expect(runtimeOptions.env?.PYTHONUTF8).toBe('1')
      expect(runtimeOptions.env?.PYTHONIOENCODING).toBe('utf-8')
      expect(runtimeOptions.env?.JUDGE_API_KEY).toBe('judge-key')
      expect(runtimeOptions.env?.JUDGE_BASE_URL).toBe('https://judge.example.com')
      expect(runtimeOptions.env?.JUDGE_MODEL).toBe('glm-5')
      expect(runtimeOptions.env?.EVAL_BACKEND).toBe('vlmevalkit')
      expect(runtimeOptions.env?.VLMEVAL_MODEL_ID).toBe('glm-registry-key')
      expect(runtimeOptions.env?.VLMEVAL_USE_CUSTOM_MODEL).toBe('true')

      await bridge.stop()
    } finally {
      if (previousPythonUtf8 === undefined) {
        delete process.env.PYTHONUTF8
      } else {
        process.env.PYTHONUTF8 = previousPythonUtf8
      }

      if (previousPythonIoEncoding === undefined) {
        delete process.env.PYTHONIOENCODING
      } else {
        process.env.PYTHONIOENCODING = previousPythonIoEncoding
      }
    }
  })
})
