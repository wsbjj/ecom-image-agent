import type { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('tasks')
    .addColumn('product_images', 'text')
    .execute()

  await db.schema
    .alterTable('tasks')
    .addColumn('reference_images', 'text')
    .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('tasks').dropColumn('product_images').execute()
  await db.schema.alterTable('tasks').dropColumn('reference_images').execute()
}
