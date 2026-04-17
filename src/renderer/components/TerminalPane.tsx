import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useAgentStore } from '../store/agent.store'
import type { LoopEvent } from '../../shared/types'
import 'xterm/css/xterm.css'

const COLOR = {
  thought: '\x1b[36m',
  act: '\x1b[33m',
  observe: '\x1b[34m',
  success: '\x1b[32m',
  failed: '\x1b[31m',
  reset: '\x1b[0m',
} as const satisfies Record<LoopEvent['phase'] | 'reset', string>

function patchXtermViewportRaceGuards(term: Terminal): void {
  const termInternal = term as unknown as {
    _core?: {
      _renderService?: unknown
      _viewport?: {
        _innerRefresh?: (...args: unknown[]) => unknown
        syncScrollArea?: (...args: unknown[]) => unknown
      }
    }
  }

  const core = termInternal._core
  const viewport = core?._viewport
  if (!core || !viewport) return

  const wrapViewportMethod = (key: '_innerRefresh' | 'syncScrollArea'): void => {
    const fn = viewport[key]
    if (typeof fn !== 'function') return
    const original = fn.bind(viewport) as (...args: unknown[]) => unknown

    viewport[key] = ((...args: unknown[]) => {
      if (!core._renderService) {
        return undefined
      }
      try {
        return original(...args)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.toLowerCase().includes('dimensions')) {
          return undefined
        }
        throw error
      }
    }) as typeof fn
  }

  wrapViewportMethod('_innerRefresh')
  wrapViewportMethod('syncScrollArea')
}

export function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const handleLoopEvent = useAgentStore((s) => s.handleLoopEvent)
  const logLines = useAgentStore((s) => s.logLines)
  const [copyLabel, setCopyLabel] = useState('复制日志')

  const copySelection = async (term: Terminal): Promise<void> => {
    const selected = term.getSelection()
    if (!selected) return
    try {
      await navigator.clipboard.writeText(selected)
    } catch {
      // Ignore clipboard failures (e.g., permission denied).
    }
  }

  const copyAllLogs = useCallback(async () => {
    const content = logLines.join('\n')
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      setCopyLabel('已复制')
      setTimeout(() => setCopyLabel('复制日志'), 1200)
    } catch {
      setCopyLabel('复制失败')
      setTimeout(() => setCopyLabel('复制日志'), 1200)
    }
  }, [logLines])

  useEffect(() => {
    if (!containerRef.current) return

    try {
      const container = containerRef.current
      let disposed = false
      let terminalReady = false
      const pendingWrites: string[] = []

      const term = new Terminal({
        fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", monospace',
        fontSize: 13,
        theme: { background: '#0d1117', foreground: '#c9d1d9' },
        convertEol: true,
        scrollback: 5000,
        cursorBlink: false,
        disableStdin: true,
      })
      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      let terminalOpened = false

      const safeFit = (): void => {
        if (disposed) return
        if (!container.isConnected) return
        if (!termRef.current || !terminalOpened) return
        try {
          fitAddon.fit()
        } catch {
          // Ignore transient fit race errors caused by strict-mode double mount.
        }
      }

      const flushPendingWrites = (): void => {
        if (!terminalReady) return
        while (pendingWrites.length > 0) {
          const line = pendingWrites.shift()
          if (!line) continue
          try {
            term.writeln(line)
          } catch {
            // Ignore transient write races caused by renderer teardown.
          }
        }
      }

      const safeWrite = (line: string): void => {
        if (disposed) return
        if (!terminalReady || !terminalOpened) {
          pendingWrites.push(line)
          return
        }
        try {
          term.writeln(line)
        } catch {
          // Ignore transient write races caused by renderer teardown.
        }
      }

      const observer = new ResizeObserver(() => {
        safeFit()
      })

      const openAndActivateTerminal = (): void => {
        if (disposed || terminalOpened) return
        if (!container.isConnected) return

        term.open(container)
        terminalOpened = true
        termRef.current = term
        patchXtermViewportRaceGuards(term)

        safeFit()
        terminalReady = true
        flushPendingWrites()
        observer.observe(container)
      }

      const rafId = window.requestAnimationFrame(() => {
        openAndActivateTerminal()
      })
      safeWrite('\x1b[1;36m=== EcomAgent Terminal ===\x1b[0m')
      safeWrite('\x1b[2m提示: 选中文本后按 Ctrl/Cmd + C 可复制\x1b[0m')
      safeWrite('')

      term.attachCustomKeyEventHandler((event) => {
        const isCopy = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c'
        if (isCopy && term.hasSelection()) {
          void copySelection(term)
          return false
        }
        return true
      })

      const handleContextMenu = (event: MouseEvent): void => {
        if (!term.hasSelection()) return
        event.preventDefault()
        void copySelection(term)
      }
      containerRef.current.addEventListener('contextmenu', handleContextMenu)

      const unsubscribe = window.api.onAgentEvent((event: LoopEvent) => {
        if (disposed) return
        handleLoopEvent(event)
        const color = COLOR[event.phase]
        const ts = new Date(event.timestamp).toLocaleTimeString()
        safeWrite(
          `${color}[${ts}] [${event.phase.toUpperCase()}] [第 ${event.roundIndex + 1} 轮] ${event.message}${COLOR.reset}`,
        )
        if (event.score !== undefined) {
          safeWrite(`  → 评分: \x1b[1m${event.score}/100\x1b[0m`)
        }
        if (event.contextUsage) {
          safeWrite(
            `  → 上下文: ${event.contextUsage.totalTokens}/${event.contextUsage.maxTokens} (${event.contextUsage.percentage.toFixed(1)}%)`,
          )
        }
        if (event.costUsd !== undefined) {
          safeWrite(`  → 累计费用: $${event.costUsd.toFixed(4)}`)
        }
      })

      return () => {
        disposed = true
        terminalReady = false
        terminalOpened = false
        pendingWrites.length = 0
        window.cancelAnimationFrame(rafId)
        observer.disconnect()
        unsubscribe()
        container.removeEventListener('contextmenu', handleContextMenu)
        termRef.current = null
        term.dispose()
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '终端初始化失败'
      console.error('[TerminalPane] init failed:', message)
      if (containerRef.current) {
        containerRef.current.innerHTML =
          '<div style="padding:12px;color:#fca5a5;font-size:12px;">终端初始化失败，请刷新页面后重试。</div>'
      }
      return
    }
  }, [handleLoopEvent])

  return (
    <div className="relative h-full w-full rounded-lg overflow-hidden border border-gray-700/40">
      <button
        onClick={copyAllLogs}
        className="absolute top-2 right-2 z-10 px-2 py-1 text-xs rounded bg-gray-800/90 text-gray-300 hover:text-white border border-gray-600/70 hover:border-gray-500 transition-colors"
      >
        {copyLabel}
      </button>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}
