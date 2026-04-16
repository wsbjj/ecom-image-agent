import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM evaluation_templates`.execute(db)
  await sql`DELETE FROM config WHERE key = 'EVAL_TEMPLATE_DEFAULT_ID'`.execute(db)
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // irreversible cleanup migration
}
