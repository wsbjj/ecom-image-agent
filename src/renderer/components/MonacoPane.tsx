import { useRef, useCallback } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'

interface MonacoPaneProps {
  value: string
  onChange: (value: string) => void
  language?: string
  readOnly?: boolean
}

export function MonacoPane({
  value,
  onChange,
  language = 'json',
  readOnly = false,
}: MonacoPaneProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)

  const handleMount: OnMount = useCallback((ed) => {
    editorRef.current = ed
  }, [])

  const handleChange = useCallback(
    (val: string | undefined) => {
      onChange(val ?? '')
    },
    [onChange],
  )

  return (
    <div className="h-full w-full rounded-lg overflow-hidden border border-gray-700">
      <Editor
        height="100%"
        language={language}
        theme="vs-dark"
        value={value}
        onChange={handleChange}
        onMount={handleMount}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: '"JetBrains Mono", "Cascadia Code", monospace',
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          tabSize: 2,
          automaticLayout: true,
          lineNumbers: 'on',
          renderWhitespace: 'selection',
        }}
      />
    </div>
  )
}
