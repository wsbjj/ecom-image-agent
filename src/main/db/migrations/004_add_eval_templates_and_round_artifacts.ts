import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('evaluation_templates')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('default_threshold', 'integer', (col) => col.notNull().defaultTo(85))
    .addColumn('rubric_json', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createTable('task_round_artifacts')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('task_id', 'text', (col) => col.notNull().references('tasks.task_id').onDelete('cascade'))
    .addColumn('round_index', 'integer', (col) => col.notNull())
    .addColumn('generated_image_path', 'text', (col) => col.notNull())
    .addColumn('preview_image_path', 'text')
    .addColumn('context_thumb_path', 'text')
    .addColumn('score', 'real')
    .addColumn('context_usage', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
    .execute()

  await db.schema
    .createIndex('task_round_artifacts_task_round_idx')
    .ifNotExists()
    .on('task_round_artifacts')
    .columns(['task_id', 'round_index'])
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('task_round_artifacts_task_round_idx').ifExists().execute()
  await db.schema.dropTable('task_round_artifacts').ifExists().execute()
  await db.schema.dropTable('evaluation_templates').ifExists().execute()
}
