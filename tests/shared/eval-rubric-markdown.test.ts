import { describe, expect, it } from 'vitest'
import type { EvalRubric } from '../../src/shared/types'
import {
  EvalRubricMarkdownError,
  formatEvalRubricMarkdown,
  parseEvalRubricMarkdown,
} from '../../src/shared/eval-rubric-markdown'

const VALID_MARKDOWN = `
## 评分维度

| key | 名称 | 满分 | 权重 | 描述 |
| --- | --- | --- | --- | --- |
| edge_distortion | 边缘畸变 | 30 | 0.3 | 检查商品边缘是否清晰 |
| perspective_lighting | 透视与光影 | 30 | 0.3 | 检查透视和光影方向 |
| hallucination | 幻觉物体 | 30 | 0.3 | 检查错误物体与错误文字 |
| overall_quality | 整体商业质量 | 10 | 0.1 | 综合评估可用性 |

## 评分说明

保持写实一致性，给出可执行修正建议。
`.trim()

describe('eval rubric markdown parser', () => {
  it('parses valid markdown rubric', () => {
    const parsed = parseEvalRubricMarkdown(VALID_MARKDOWN)
    expect(parsed.dimensions).toHaveLength(4)
    expect(parsed.dimensions[0]).toEqual({
      key: 'edge_distortion',
      name: '边缘畸变',
      maxScore: 30,
      weight: 0.3,
      description: '检查商品边缘是否清晰',
    })
    expect(parsed.scoringNotes).toContain('保持写实一致性')
  })

  it('throws clear error on missing required table header columns', () => {
    const bad = VALID_MARKDOWN.replace(
      '| key | 名称 | 满分 | 权重 | 描述 |',
      '| key | name | 满分 | 权重 | 描述 |',
    )
    expect(() => parseEvalRubricMarkdown(bad)).toThrow(EvalRubricMarkdownError)
    expect(() => parseEvalRubricMarkdown(bad)).toThrow(/评分维度表头必须为/)
  })

  it('throws clear error on duplicate keys', () => {
    const bad = VALID_MARKDOWN.replace('perspective_lighting', 'edge_distortion')
    expect(() => parseEvalRubricMarkdown(bad)).toThrow(EvalRubricMarkdownError)
    expect(() => parseEvalRubricMarkdown(bad)).toThrow(/维度 key 重复/)
  })

  it('supports rubric -> markdown -> rubric round-trip', () => {
    const rubric: EvalRubric = {
      dimensions: [
        {
          key: 'edge_distortion',
          name: '边缘畸变',
          maxScore: 30,
          weight: 0.3,
          description: '检查商品边缘是否清晰',
        },
        {
          key: 'overall_quality',
          name: '整体商业质量',
          maxScore: 10,
          weight: 0.1,
          description: '综合评估是否可发布',
        },
      ],
      scoringNotes: '保持写实一致性，给出可执行修正建议。',
    }

    const markdown = formatEvalRubricMarkdown(rubric)
    const parsed = parseEvalRubricMarkdown(markdown)
    expect(parsed).toEqual(rubric)
  })
})
