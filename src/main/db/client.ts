import Database from 'better-sqlite3'
import {
  Kysely,
  SqliteDialect,
  Migrator,
  type MigrationProvider,
  type Migration,
  type Generated,
} from 'kysely'
import { app } from 'electron'
import * as path from 'node:path'
import { up as up001, down as down001 } from './migrations/001_create_tasks'
import { up as up002, down as down002 } from './migrations/002_create_templates'

export interface TaskTable {
  id: Generated<number>
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
  created_at: Generated<string>
  updated_at: string | null
}

export interface TemplateTable {
  id: Generated<number>
  name: string
  style: string
  lighting: string
  system_prompt: string
  created_at: Generated<string>
}

export interface ConfigTable {
  key: string
  value: string
}

export interface DatabaseSchema {
  tasks: TaskTable
  templates: TemplateTable
  config: ConfigTable
}

class InlineMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve({
      '001_create_tasks': { up: up001, down: down001 },
      '002_create_templates': { up: up002, down: down002 },
    })
  }
}

function createDb(): Kysely<DatabaseSchema> {
  const dbPath = path.join(app.getPath('userData'), 'ecom-agent.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: sqlite }),
  })
}

export const db = createDb()

export async function runMigrations(): Promise<void> {
  const migrator = new Migrator({ db, provider: new InlineMigrationProvider() })
  const { error, results } = await migrator.migrateToLatest()
  if (error) throw error
  results?.forEach((r) => {
    console.log(`[Migration] ${r.migrationName}: ${r.status}`)
  })
}
