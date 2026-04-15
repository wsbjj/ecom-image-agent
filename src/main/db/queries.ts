import { db } from './client'
import type { TaskRecord, TemplateRecord, TemplateInput } from '../../shared/types'

export async function insertTask(params: {
  taskId: string
  skuId: string
  productName: string
}): Promise<void> {
  await db
    .insertInto('tasks')
    .values({
      task_id: params.taskId,
      sku_id: params.skuId,
      product_name: params.productName,
      retry_count: 0,
      status: 'running',
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
  const rows = await db
    .selectFrom('tasks')
    .selectAll()
    .orderBy('created_at', 'desc')
    .execute()
  return rows as TaskRecord[]
}

export async function getConfigValue(key: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('config')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst()
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
  const rows = await db
    .selectFrom('templates')
    .selectAll()
    .orderBy('created_at', 'desc')
    .execute()
  return rows as TemplateRecord[]
}

export async function deleteTemplate(id: number): Promise<void> {
  await db.deleteFrom('templates').where('id', '=', id).execute()
}
