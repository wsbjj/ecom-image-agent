import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => '/tmp/ecom-image-agent'),
    getPath: vi.fn(() => '/tmp/ecom-image-agent-user-data'),
  },
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
})
