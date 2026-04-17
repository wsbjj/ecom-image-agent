import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

const mockTerminalDispose = vi.fn()
const mockTerminalWriteln = vi.fn()
const mockTerminalLoadAddon = vi.fn()
const mockTerminalOpen = vi.fn()
const mockTerminalAttachKey = vi.fn()
const mockFit = vi.fn()

const resizeObserverInstances: Array<{ callback: ResizeObserverCallback; disconnect: () => void }> = []

vi.mock('xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    loadAddon: mockTerminalLoadAddon,
    open: mockTerminalOpen,
    writeln: mockTerminalWriteln,
    attachCustomKeyEventHandler: mockTerminalAttachKey,
    hasSelection: vi.fn(() => false),
    getSelection: vi.fn(() => ''),
    dispose: mockTerminalDispose,
  })),
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: mockFit,
  })),
}))

import { TerminalPane } from '../../../src/renderer/components/TerminalPane'

describe('TerminalPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resizeObserverInstances.length = 0

    class MockResizeObserver {
      readonly callback: ResizeObserverCallback

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        resizeObserverInstances.push({
          callback,
          disconnect: this.disconnect.bind(this),
        })
      }

      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }

    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback): number => {
      cb(0)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does not throw on fit race or late resize callback after unmount', () => {
    mockFit.mockImplementation(() => {
      throw new Error('fit-race')
    })

    const { unmount } = render(<TerminalPane />)
    expect(resizeObserverInstances.length).toBeGreaterThan(0)

    unmount()

    expect(() => {
      resizeObserverInstances[0]?.callback([], {} as ResizeObserver)
    }).not.toThrow()
    expect(mockTerminalDispose).toHaveBeenCalledTimes(1)
  })
})
