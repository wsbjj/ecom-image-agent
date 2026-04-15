import { useEffect, useRef } from 'react'
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

export function TerminalPane(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const handleLoopEvent = useAgentStore((s) => s.handleLoopEvent)

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
      term.writeln('')

      const unsubscribe = window.api.onAgentEvent((event: LoopEvent) => {
        handleLoopEvent(event)
        const color = COLOR[event.phase]
        const ts = new Date(event.timestamp).toLocaleTimeString()
        term.writeln(
          `${color}[${ts}] [${event.phase.toUpperCase()}] ${event.message}${COLOR.reset}`,
        )
        if (event.score !== undefined) {
          term.writeln(`  → 评分: \x1b[1m${event.score}/100\x1b[0m`)
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

  return <div ref={containerRef} className="h-full w-full rounded-lg overflow-hidden" />
}
