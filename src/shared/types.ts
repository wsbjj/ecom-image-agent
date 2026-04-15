export interface DefectAnalysis {
  edge_distortion: { score: number; issues: string[] }
  perspective_lighting: { score: number; issues: string[] }
  hallucination: { score: number; issues: string[] }
  overall_recommendation: string
}

export interface LoopEvent {
  taskId: string
  phase: 'thought' | 'act' | 'observe' | 'success' | 'failed'
  message: string
  score?: number
  defectAnalysis?: DefectAnalysis
  retryCount: number
  costUsd?: number
  timestamp: number
}

export interface ImageAsset {
  path: string
  angle?: 'front' | 'side' | 'top' | 'detail' | string
  isPrimary?: boolean
}

export type ImageProviderName = 'gemini' | 'seedream'

export interface TaskInput {
  skuId: string
  productName: string
  context: string
  templateId: number
  taskId?: string
  productImages: ImageAsset[]
  referenceImages?: ImageAsset[]
  userPrompt?: string
}

export interface EvalRequest {
  requestId: string
  imagePath: string
  productName: string
  context: string
}

export interface EvalResult {
  totalScore: number
  defectAnalysis: DefectAnalysis
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
