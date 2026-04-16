import type { EvalRubric, EvalRubricDimension } from './types'

const DIMENSIONS_HEADING = '## 评分维度'
const NOTES_HEADING = '## 评分说明'
const EXPECTED_COLUMNS = ['key', '名称', '满分', '权重', '描述'] as const

interface NonEmptyLine {
  text: string
  lineNumber: number
}

export class EvalRubricMarkdownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvalRubricMarkdownError'
  }
}

function fail(message: string, lineNumber?: number): never {
  if (lineNumber) {
    throw new EvalRubricMarkdownError(`第 ${lineNumber} 行: ${message}`)
  }
  throw new EvalRubricMarkdownError(message)
}

function normalizeLines(markdown: string): string[] {
  return markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

function findHeadingLine(lines: string[], headingText: string): number {
  const pattern = new RegExp(`^##\\s*${headingText}\\s*$`)
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (pattern.test(lines[idx].trim())) {
      return idx
    }
  }
  return -1
}

function parsePipeCells(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return []

  let body = trimmed.slice(1)
  if (body.endsWith('|')) {
    body = body.slice(0, -1)
  }

  const cells: string[] = []
  let current = ''
  for (let idx = 0; idx < body.length; idx += 1) {
    const ch = body[idx]
    if (ch === '\\' && body[idx + 1] === '|') {
      current += '|'
      idx += 1
      continue
    }
    if (ch === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current.trim())
  return cells.map((cell) => cell.replace(/<br\s*\/?>/gi, '\n'))
}

function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '<br/>')
    .trim()
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return String(value)
}

function collectNonEmptyLines(lines: string[], start: number, end: number): NonEmptyLine[] {
  const result: NonEmptyLine[] = []
  for (let idx = start; idx < end; idx += 1) {
    const text = lines[idx]
    if (text.trim().length === 0) continue
    result.push({
      text,
      lineNumber: idx + 1,
    })
  }
  return result
}

function parseDimensionTable(lines: string[], start: number, end: number): EvalRubricDimension[] {
  const nonEmpty = collectNonEmptyLines(lines, start, end)
  if (nonEmpty.length < 2) {
    fail('评分维度表格缺失，请提供 Markdown 表格。')
  }

  const headerCells = parsePipeCells(nonEmpty[0].text)
  if (headerCells.length !== EXPECTED_COLUMNS.length) {
    fail(`评分维度表头列数必须为 ${EXPECTED_COLUMNS.length} 列。`, nonEmpty[0].lineNumber)
  }

  const [headerKey, headerName, headerMaxScore, headerWeight, headerDescription] = headerCells
  if (
    headerKey.toLowerCase() !== EXPECTED_COLUMNS[0] ||
    headerName !== EXPECTED_COLUMNS[1] ||
    headerMaxScore !== EXPECTED_COLUMNS[2] ||
    headerWeight !== EXPECTED_COLUMNS[3] ||
    headerDescription !== EXPECTED_COLUMNS[4]
  ) {
    fail(
      `评分维度表头必须为: ${EXPECTED_COLUMNS.join(' | ')}`,
      nonEmpty[0].lineNumber,
    )
  }

  const separatorCells = parsePipeCells(nonEmpty[1].text)
  if (
    separatorCells.length !== EXPECTED_COLUMNS.length ||
    separatorCells.some((cell) => !/^:?-{3,}:?$/.test(cell))
  ) {
    fail('评分维度表格第二行必须是分隔线（例如 | --- | --- | ... |）。', nonEmpty[1].lineNumber)
  }

  const dimensions: EvalRubricDimension[] = []
  const seenKeys = new Set<string>()
  for (let idx = 2; idx < nonEmpty.length; idx += 1) {
    const row = nonEmpty[idx]
    const cells = parsePipeCells(row.text)
    if (cells.length !== EXPECTED_COLUMNS.length) {
      fail(`评分维度数据列数必须为 ${EXPECTED_COLUMNS.length} 列。`, row.lineNumber)
    }

    const [keyRaw, nameRaw, maxScoreRaw, weightRaw, descriptionRaw] = cells
    const key = keyRaw.trim()
    const name = nameRaw.trim()
    const description = descriptionRaw.trim()

    if (!key) fail('维度 key 不能为空。', row.lineNumber)
    if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(key)) {
      fail('维度 key 仅支持字母、数字、下划线和中划线，且不能以中划线开头。', row.lineNumber)
    }

    const normalizedKey = key.toLowerCase()
    if (seenKeys.has(normalizedKey)) {
      fail(`维度 key 重复: ${key}`, row.lineNumber)
    }
    seenKeys.add(normalizedKey)

    if (!name) fail(`维度 ${key} 的名称不能为空。`, row.lineNumber)
    if (!description) fail(`维度 ${key} 的描述不能为空。`, row.lineNumber)

    if (!/^\d+$/.test(maxScoreRaw.trim())) {
      fail(`维度 ${key} 的满分必须是正整数。`, row.lineNumber)
    }
    const maxScore = Number.parseInt(maxScoreRaw.trim(), 10)
    if (!Number.isInteger(maxScore) || maxScore <= 0) {
      fail(`维度 ${key} 的满分必须大于 0。`, row.lineNumber)
    }

    const weight = Number.parseFloat(weightRaw.trim())
    if (!Number.isFinite(weight) || weight < 0) {
      fail(`维度 ${key} 的权重必须是大于等于 0 的数字。`, row.lineNumber)
    }

    dimensions.push({
      key,
      name,
      maxScore,
      weight,
      description,
    })
  }

  if (dimensions.length === 0) {
    fail('评分维度不能为空。')
  }

  return dimensions
}

export function parseEvalRubricMarkdown(markdown: string): EvalRubric {
  const lines = normalizeLines(markdown)
  const dimensionsHeadingLine = findHeadingLine(lines, '评分维度')
  if (dimensionsHeadingLine < 0) {
    fail(`缺少 ${DIMENSIONS_HEADING} 段落。`)
  }

  const notesHeadingLine = findHeadingLine(lines, '评分说明')
  if (notesHeadingLine >= 0 && notesHeadingLine <= dimensionsHeadingLine) {
    fail(`段落顺序错误，${NOTES_HEADING} 必须在 ${DIMENSIONS_HEADING} 后。`, notesHeadingLine + 1)
  }

  const tableEnd = notesHeadingLine >= 0 ? notesHeadingLine : lines.length
  const dimensions = parseDimensionTable(lines, dimensionsHeadingLine + 1, tableEnd)

  const notes =
    notesHeadingLine >= 0 ? lines.slice(notesHeadingLine + 1).join('\n').trim() : undefined

  return {
    dimensions,
    ...(notes ? { scoringNotes: notes } : {}),
  }
}

export function formatEvalRubricMarkdown(rubric: EvalRubric): string {
  const lines = [
    DIMENSIONS_HEADING,
    '',
    `| ${EXPECTED_COLUMNS.join(' | ')} |`,
    '| --- | --- | --- | --- | --- |',
    ...rubric.dimensions.map((item) => {
      const key = escapeMarkdownCell(item.key)
      const name = escapeMarkdownCell(item.name)
      const maxScore = formatNumber(item.maxScore)
      const weight = formatNumber(item.weight)
      const description = escapeMarkdownCell(item.description)
      return `| ${key} | ${name} | ${maxScore} | ${weight} | ${description} |`
    }),
    '',
    NOTES_HEADING,
    '',
    rubric.scoringNotes?.trim() || '保持写实一致性，给出可执行修正建议。',
  ]

  return lines.join('\n')
}
