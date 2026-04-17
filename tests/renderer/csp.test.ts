import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('renderer CSP', () => {
  it('adds CSP meta to renderer index.html without unsafe-eval', () => {
    const indexHtmlPath = path.resolve(process.cwd(), 'src/renderer/index.html')
    const html = fs.readFileSync(indexHtmlPath, 'utf8')

    expect(html).toContain('http-equiv="Content-Security-Policy"')
    expect(html).toContain("script-src 'self'")
    expect(html.toLowerCase()).not.toContain('unsafe-eval')
  })
})
