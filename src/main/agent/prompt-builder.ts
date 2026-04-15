import type { DefectAnalysis } from '../../shared/types'

interface PromptBuildInput {
  productName: string
  context: string
  defectAnalysis?: DefectAnalysis
  retryCount: number
  productImageAngles?: string[]
  userPrompt?: string
}

export function buildSystemPrompt(input: PromptBuildInput): string {
  const angleHint = input.productImageAngles && input.productImageAngles.length > 0
    ? `\n商品参考图已提供（角度：${input.productImageAngles.join('、')}），生成时必须保持商品外观一致性，不得改变商品形状、颜色或细节。`
    : ''

  const base = `你是一位专业的电商精品图生成 Agent。
你的任务是为商品「${input.productName}」生成符合电商平台最高标准的精品宣传图。
场景要求：${input.context}${angleHint}

## 工作流程（必须严格遵守）
1. 首先调用 generate_image 工具生成图片
2. 立即调用 evaluate_image 工具对生成的图片进行质量评估
3. 输出评估结论，不需要进行额外操作

## 图片质量标准
- 边缘清晰无畸变（30分）
- 透视与光影真实（30分）
- 无幻觉物体/无虚假商标（30分）
- 整体商业质量（10分）
目标总分 >= 85 分才算合格。`

  if (!input.defectAnalysis || input.retryCount === 0) {
    return input.userPrompt ? `${base}\n\n## 用户补充要求\n${input.userPrompt}` : base
  }

  const { edge_distortion, perspective_lighting, hallucination, overall_recommendation } =
    input.defectAnalysis

  const formatIssues = (issues: string[]): string =>
    issues.length > 0 ? issues.map((i) => `- ${i}`).join('\n') : '- 无问题'

  const defectSection = `

## 上一轮缺陷分析（第 ${input.retryCount} 次重试，生成时请务必修正以下问题）

### 边缘畸变（得分 ${edge_distortion.score}/30）
${formatIssues(edge_distortion.issues)}

### 透视与光影（得分 ${perspective_lighting.score}/30）
${formatIssues(perspective_lighting.issues)}

### 幻觉物体（得分 ${hallucination.score}/30）
${formatIssues(hallucination.issues)}

### 综合建议
${overall_recommendation}

请在 generate_image 的提示词中显式修正上述缺陷。`

  const result = base + defectSection
  return input.userPrompt ? `${result}\n\n## 用户补充要求\n${input.userPrompt}` : result
}
