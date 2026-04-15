import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('tasks')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('task_id', 'text', (col) => col.notNull().unique())
    .addColumn('sku_id', 'text', (col) => col.notNull())
    .addColumn('product_name', 'text', (col) => col.notNull())
    .addColumn('retry_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('total_score', 'real')
    .addColumn('defect_analysis', 'text')
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
    .addColumn('image_path', 'text')
    .addColumn('prompt_used', 'text')
    .addColumn('cost_usd', 'real')
    .addColumn('created_at', 'text', (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn('updated_at', 'text')
    .execute()

  await db.schema
    .createTable('config')
    .ifNotExists()
    .addColumn('key', 'text', (col) => col.primaryKey())
    .addColumn('value', 'text', (col) => col.notNull())
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('tasks').ifExists().execute()
  await db.schema.dropTable('config').ifExists().execute()
}
