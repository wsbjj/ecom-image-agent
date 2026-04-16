import type { DefectAnalysis } from '../../shared/types'

interface EnforcedPromptInput {
  productName: string
  context: string
  userPrompt?: string
  modelPrompt?: string
  defectAnalysis?: DefectAnalysis | null
  roundIndex: number
}

function normalizeLine(value: string | undefined): string {
  if (!value) return ''
  return value
    .replace(/\s+/g, ' ')
    .trim()
}

function collectDefectHints(defectAnalysis?: DefectAnalysis | null, limit = 4): string[] {
  if (!defectAnalysis || !Array.isArray(defectAnalysis.dimensions)) {
    return []
  }

  return defectAnalysis.dimensions
    .flatMap((dimension) => dimension.issues.slice(0, 2))
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, limit)
}

export function buildEnforcedGenerationPrompt(input: EnforcedPromptInput): string {
  const normalizedUserPrompt = normalizeLine(input.userPrompt)
  const normalizedModelPrompt = input.modelPrompt?.trim() ?? ''
  const defectHints = collectDefectHints(input.defectAnalysis)
  const recommendation = normalizeLine(input.defectAnalysis?.overall_recommendation)

  const lines = [
    'Generate one high-quality e-commerce product image.',
    'Hard constraints that must be preserved:',
    `- Product name: ${input.productName}`,
    `- Scene/context: ${input.context}`,
  ]

  if (normalizedUserPrompt) {
    lines.push(`- User requirements: ${normalizedUserPrompt}`)
  }

  if (input.roundIndex > 0 && defectHints.length > 0) {
    lines.push(`- Fix issues from previous round: ${defectHints.join('; ')}`)
  }

  if (input.roundIndex > 0 && recommendation) {
    lines.push(`- Optimization guidance: ${recommendation}`)
  }

  if (normalizedModelPrompt) {
    lines.push('', 'Model draft prompt (keep only details that do not conflict with hard constraints):')
    lines.push(normalizedModelPrompt)
  } else {
    lines.push('', 'If no extra draft is provided, optimize composition, lighting, and realism under all hard constraints above.')
  }

  return lines.join('\n')
}

export function buildFallbackDraftPrompt(productName: string, context: string): string {
  return `Generate a realistic e-commerce image for ${productName} in ${context}.`
}
