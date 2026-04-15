export interface GenerateImageParams {
  prompt: string
  productImagePaths: string[]
  referenceImagePaths?: string[]
  aspectRatio?: '1:1' | '4:3' | '16:9'
  style?: string
}

export interface GenerateImageResult {
  imagePath: string
  promptUsed: string
  costUsd?: number
  debugInfo?: {
    requestId?: string
    taskId?: string
    providerMode?: 'visual_official' | 'openai_compat'
    fallbackReason?: string
  }
}

export interface ImageProvider {
  readonly name: string
  generate(params: GenerateImageParams): Promise<GenerateImageResult>
}
