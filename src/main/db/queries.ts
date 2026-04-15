import { db } from './client'
import type {
  TaskRecord,
  TemplateRecord,
  TemplateInput,
  EvaluationTemplateInput,
  EvaluationTemplateRecord,
  TaskRoundArtifactRecord,
  EvalRubric,
} from '../../shared/types'

export async function insertTask(params: {
  taskId: string
  skuId: string
  productName: string
  productImages?: string | null
  referenceImages?: string | null
}): Promise<void> {
  await db
    .insertInto('tasks')
    .values({
      task_id: params.taskId,
      sku_id: params.skuId,
      product_name: params.productName,
      retry_count: 0,
      status: 'running',
      product_images: params.productImages ?? null,
      reference_images: params.referenceImages ?? null,
    })
    .execute()
}

export async function updateTaskSuccess(params: {
  taskId: string
  totalScore: number
  defectAnalysis: string
  imagePath: string
  retryCount: number
  costUsd: number
}): Promise<void> {
  await db
    .updateTable('tasks')
    .set({
      status: 'success',
      total_score: params.totalScore,
      defect_analysis: params.defectAnalysis,
      image_path: params.imagePath,
      retry_count: params.retryCount,
      cost_usd: params.costUsd,
      updated_at: new Date().toISOString(),
    })
    .where('task_id', '=', params.taskId)
    .execute()
}

export async function updateTaskFailed(params: {
  taskId: string
  retryCount: number
  costUsd?: number
}): Promise<void> {
  await db
    .updateTable('tasks')
    .set({
      status: 'failed',
      retry_count: params.retryCount,
      cost_usd: params.costUsd ?? null,
      updated_at: new Date().toISOString(),
    })
    .where('task_id', '=', params.taskId)
    .execute()
}

export async function listTasks(): Promise<TaskRecord[]> {
  const rows = await db.selectFrom('tasks').selectAll().orderBy('created_at', 'desc').execute()
  return rows as TaskRecord[]
}

export async function insertTaskRoundArtifact(params: {
  taskId: string
  roundIndex: number
  generatedImagePath: string
  previewImagePath?: string | null
  contextThumbPath?: string | null
  score?: number | null
  contextUsage?: string | null
}): Promise<void> {
  await db
    .insertInto('task_round_artifacts')
    .values({
      task_id: params.taskId,
      round_index: params.roundIndex,
      generated_image_path: params.generatedImagePath,
      preview_image_path: params.previewImagePath ?? null,
      context_thumb_path: params.contextThumbPath ?? null,
      score: params.score ?? null,
      context_usage: params.contextUsage ?? null,
    })
    .execute()
}

export async function updateTaskRoundArtifactScore(params: {
  taskId: string
  roundIndex: number
  score: number
  contextUsage?: string | null
}): Promise<void> {
  await db
    .updateTable('task_round_artifacts')
    .set({
      score: params.score,
      context_usage: params.contextUsage ?? null,
    })
    .where('task_id', '=', params.taskId)
    .where('round_index', '=', params.roundIndex)
    .execute()
}

export async function listTaskRoundArtifacts(taskId: string): Promise<TaskRoundArtifactRecord[]> {
  const rows = await db
    .selectFrom('task_round_artifacts')
    .selectAll()
    .where('task_id', '=', taskId)
    .orderBy('round_index', 'asc')
    .execute()
  return rows as TaskRoundArtifactRecord[]
}

export async function getConfigValue(key: string): Promise<string | undefined> {
  const row = await db.selectFrom('config').select('value').where('key', '=', key).executeTakeFirst()
  return row?.value
}

export async function setConfigValue(key: string, value: string): Promise<void> {
  await db
    .insertInto('config')
    .values({ key, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
    .execute()
}

export async function insertTemplate(input: TemplateInput): Promise<void> {
  await db
    .insertInto('templates')
    .values({
      name: input.name,
      style: input.style,
      lighting: input.lighting,
      system_prompt: input.system_prompt,
    })
    .execute()
}

export async function listTemplates(): Promise<TemplateRecord[]> {
  const rows = await db.selectFrom('templates').selectAll().orderBy('created_at', 'desc').execute()
  return rows as TemplateRecord[]
}

export async function deleteTemplate(id: number): Promise<void> {
  await db.deleteFrom('templates').where('id', '=', id).execute()
}

export async function insertEvaluationTemplate(input: EvaluationTemplateInput): Promise<void> {
  await db
    .insertInto('evaluation_templates')
    .values({
      name: input.name,
      version: input.version,
      default_threshold: input.defaultThreshold,
      rubric_json: JSON.stringify(input.rubric),
    })
    .execute()
}

export async function listEvaluationTemplates(): Promise<EvaluationTemplateRecord[]> {
  const rows = await db
    .selectFrom('evaluation_templates')
    .selectAll()
    .orderBy('created_at', 'desc')
    .execute()
  return rows as EvaluationTemplateRecord[]
}

export async function getEvaluationTemplateById(
  id: number,
): Promise<EvaluationTemplateRecord | undefined> {
  const row = await db
    .selectFrom('evaluation_templates')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  return row as EvaluationTemplateRecord | undefined
}

export async function deleteEvaluationTemplate(id: number): Promise<void> {
  await db.deleteFrom('evaluation_templates').where('id', '=', id).execute()
}

export function buildDefaultEvalRubric(): EvalRubric {
  return {
    dimensions: [
      {
        key: 'edge_distortion',
        name: '边缘畸变',
        maxScore: 30,
        weight: 0.3,
        description: '检查商品边缘是否清晰、无拉伸和锯齿。',
      },
      {
        key: 'perspective_lighting',
        name: '透视与光影',
        maxScore: 30,
        weight: 0.3,
        description: '检查透视关系、阴影方向与强度是否符合写实逻辑。',
      },
      {
        key: 'hallucination',
        name: '幻觉物体',
        maxScore: 30,
        weight: 0.3,
        description: '检查是否出现错误的文字、logo、物体或产品结构变化。',
      },
      {
        key: 'overall_quality',
        name: '整体商业质量',
        maxScore: 10,
        weight: 0.1,
        description: '构图、质感、商业可用性、平台主图标准整体判断。',
      },
    ],
    scoringNotes:
      '需要严格写实；分项描述应给出可执行修改建议。若发现致命错误（错品、严重畸变），对应分项不高于满分的一半。',
  }
}

export async function ensureDefaultEvaluationTemplate(): Promise<EvaluationTemplateRecord> {
  const existing = await db
    .selectFrom('evaluation_templates')
    .selectAll()
    .where('name', '=', '默认电商评估标准')
    .where('version', '=', 1)
    .executeTakeFirst()

  if (existing) {
    return existing as EvaluationTemplateRecord
  }

  const rubric = buildDefaultEvalRubric()
  await insertEvaluationTemplate({
    name: '默认电商评估标准',
    version: 1,
    defaultThreshold: 85,
    rubric,
  })

  const created = await db
    .selectFrom('evaluation_templates')
    .selectAll()
    .where('name', '=', '默认电商评估标准')
    .where('version', '=', 1)
    .orderBy('id', 'desc')
    .executeTakeFirstOrThrow()

  return created as EvaluationTemplateRecord
}
