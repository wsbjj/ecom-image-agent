export interface LegacyDefectAnalysis {
  edge_distortion: { score: number; issues: string[] }
  perspective_lighting: { score: number; issues: string[] }
  hallucination: { score: number; issues: string[] }
}

export interface EvalDimensionResult {
  key: string
  name: string
  score: number
  maxScore: number
  issues: string[]
  reason?: string
  weight?: number
}

export interface DefectAnalysis {
  dimensions: EvalDimensionResult[]
  overall_recommendation: string
  summary?: string
  legacy?: LegacyDefectAnalysis
}

export interface ContextUsageSnapshot {
  totalTokens: number
  maxTokens: number
  percentage: number
}

export interface LoopEvent {
  taskId: string
  phase: 'thought' | 'act' | 'observe' | 'success' | 'failed'
  message: string
  score?: number
  defectAnalysis?: DefectAnalysis
  retryCount: number
  roundIndex: number
  generatedImagePath?: string
  previewImagePath?: string
  contextUsage?: ContextUsageSnapshot
  costUsd?: number
  timestamp: number
}

export interface ImageAsset {
  path: string
  angle?: 'front' | 'side' | 'top' | 'detail' | string
  isPrimary?: boolean
}

export type ImageProviderName = 'gemini' | 'seedream'
export type AgentEngineName = 'claude_sdk' | 'codex_sdk' | 'legacy'

export interface TaskInput {
  skuId: string
  productName: string
  context: string
  templateId: number
  taskId?: string
  productImages: ImageAsset[]
  referenceImages?: ImageAsset[]
  userPrompt?: string
  evaluationTemplateId?: number
  scoreThresholdOverride?: number
}

export interface EvalRubricDimension {
  key: string
  name: string
  maxScore: number
  weight: number
  description: string
}

export interface EvalRubric {
  dimensions: EvalRubricDimension[]
  scoringNotes?: string
}

export interface EvalRequest {
  requestId: string
  imagePath: string
  productName: string
  context: string
  rubric: EvalRubric
  passThreshold: number
}

export interface EvalResult {
  totalScore: number
  defectAnalysis: DefectAnalysis
  passed: boolean
  passThreshold: number
}

export interface TaskRecord {
  id: number
  task_id: string
  sku_id: string
  product_name: string
  retry_count: number
  total_score: number | null
  defect_analysis: string | null
  status: 'pending' | 'running' | 'success' | 'failed'
  image_path: string | null
  prompt_used: string | null
  cost_usd: number | null
  product_images: string | null
  reference_images: string | null
  created_at: string
  updated_at: string | null
}

export interface TaskRoundArtifactRecord {
  id: number
  task_id: string
  round_index: number
  generated_image_path: string
  preview_image_path: string | null
  context_thumb_path: string | null
  score: number | null
  context_usage: string | null
  created_at: string
}

export interface TemplateRecord {
  id: number
  name: string
  style: string
  lighting: string
  system_prompt: string
  created_at: string
}

export interface TemplateInput {
  name: string
  style: string
  lighting: string
  system_prompt: string
}

export interface EvaluationTemplateRecord {
  id: number
  name: string
  version: number
  default_threshold: number
  rubric_json: string
  created_at: string
}

export interface EvaluationTemplateInput {
  name: string
  version: number
  defaultThreshold: number
  rubricMarkdown: string
}

export interface EvalTemplateDraftRequest {
  requirements: string
}

export interface EvalTemplateDraftResponse {
  name: string
  defaultThreshold: number
  rubricMarkdown: string
}
