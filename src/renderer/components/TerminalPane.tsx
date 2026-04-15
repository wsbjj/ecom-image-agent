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
      term.open(containerRef.current)

      fitAddon.fit()
      termRef.current = term
      term.writeln('\x1b[1;36m=== EcomAgent Terminal ===\x1b[0m')
      term.writeln('\x1b[2m提示: 选中文本后按 Ctrl/Cmd + C 可复制\x1b[0m')
      term.writeln('')

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
        handleLoopEvent(event)
        const color = COLOR[event.phase]
        const ts = new Date(event.timestamp).toLocaleTimeString()
        term.writeln(
          `${color}[${ts}] [${event.phase.toUpperCase()}] [第 ${event.roundIndex + 1} 轮] ${event.message}${COLOR.reset}`,
        )
        if (event.score !== undefined) {
          term.writeln(`  → 评分: \x1b[1m${event.score}/100\x1b[0m`)
        }
        if (event.contextUsage) {
          term.writeln(
            `  → 上下文: ${event.contextUsage.totalTokens}/${event.contextUsage.maxTokens} (${event.contextUsage.percentage.toFixed(1)}%)`,
          )
        }
        if (event.costUsd !== undefined) {
          term.writeln(`  → 累计费用: $${event.costUsd.toFixed(4)}`)
        }
      })

      const observer = new ResizeObserver(() => {
        fitAddon.fit()
      })
      observer.observe(containerRef.current)

      return () => {
        unsubscribe()
        observer.disconnect()
        containerRef.current?.removeEventListener('contextmenu', handleContextMenu)
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
