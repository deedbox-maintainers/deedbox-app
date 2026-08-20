// Firm mapping templates and migration completion, plus the migration
// record's start. Product and pack mapping rows are read-only to firms by
// schema rule; the wizard saves firm rows here and reuses them across runs.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireCapability } from '@/lib/ops/shared'
import { createHash } from 'node:crypto'

export async function saveMappingTemplate(
  p: Principal,
  input: { sourceFormatKey: string; recordType: string; name: string; fieldMap: unknown },
): Promise<{ id: number }> {
  if (!input.name.trim()) throw new OperationRefused('name_required', 'a mapping template needs a name')
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'import.execute')
    const r = await tx.query(
      `insert into deedbox.mapping_template (source_format_key, record_type, field_map, origin, name)
       values ($1, $2, $3, 'firm', $4) returning id`,
      [input.sourceFormatKey, input.recordType, JSON.stringify(input.fieldMap), input.name.trim()],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'mapping_template',
      subject: r.rows[0].id as number,
      detail: { name: input.name.trim(), source_format_key: input.sourceFormatKey, record_type: input.recordType },
    })
    return { id: r.rows[0].id as number }
  })
}

export async function editMappingTemplate(
  p: Principal,
  input: { id: number; name?: string; fieldMap?: unknown; active?: boolean },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'import.execute')
    const cur = await tx.query(
      `select origin, name, field_map, active from deedbox.mapping_template where id = $1 for update`,
      [input.id],
    )
    if (cur.rowCount === 0) throw new OperationRefused('not_found', 'mapping template not found')
    // the schema's guard refuses edits to product/pack rows; the typed
    // message here is friendlier than the raise
    if (cur.rows[0].origin !== 'firm') {
      throw new OperationRefused('read_only', 'product and pack mappings are read-only to firms')
    }
    await tx.query(
      `update deedbox.mapping_template
          set name = coalesce($2, name),
              field_map = coalesce($3, field_map),
              active = coalesce($4, active)
        where id = $1`,
      [
        input.id,
        input.name?.trim() ?? null,
        input.fieldMap === undefined ? null : JSON.stringify(input.fieldMap),
        input.active ?? null,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'mapping_template',
      subject: input.id,
      detail: {
        before: { name: cur.rows[0].name, active: cur.rows[0].active },
        after: {
          name: input.name?.trim() ?? cur.rows[0].name,
          active: input.active ?? cur.rows[0].active,
        },
      },
    })
  })
}

/** The migration record a run of batches hangs off. */
export async function startMigration(
  p: Principal,
  input: { sourceSystem: string },
): Promise<{ id: number }> {
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'import.execute')
    const r = await tx.query(
      `insert into deedbox.migration (source_system) values ($1) returning id`,
      [input.sourceSystem],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'migration',
      subject: r.rows[0].id as number,
      detail: { source_system: input.sourceSystem },
    })
    return { id: r.rows[0].id as number }
  })
}

/**
 * Complete a migration: the permanent, firm-visible evidence of
 * the historical boundary. The summary is computed from the migration's own
 * batches (counts per record type, every refusal with its reason) and
 * stored with its printable artefact.
 */
export async function completeMigration(
  p: Principal,
  input: { migration: number },
): Promise<{ summaryArtefact: number }> {
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'import.execute')
    const m = await tx.query(
      `select id, source_system, started_at, completed_at from deedbox.migration where id = $1 for update`,
      [input.migration],
    )
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'migration not found')
    if (m.rows[0].completed_at !== null) {
      throw new OperationRefused('already_completed', 'this migration is already completed')
    }
    const batches = await tx.query(
      `select b.id, b.record_domain, b.mode, b.state, b.counts
         from deedbox.import_batch b where b.migration = $1 order by b.id`,
      [input.migration],
    )
    const refusals = await tx.query(
      `select r.batch, r.source_ref, r.message
         from deedbox.import_record r
         join deedbox.import_batch b on b.id = r.batch
        where b.migration = $1 and r.disposition = 'refused' order by r.id`,
      [input.migration],
    )
    const summary = {
      source_system: m.rows[0].source_system,
      started_at: String(m.rows[0].started_at),
      batches: batches.rows.map((b) => ({
        batch: b.id,
        record_domain: b.record_domain,
        mode: b.mode,
        state: b.state,
        counts: b.counts,
      })),
      refusals: refusals.rows.map((r) => ({
        batch: r.batch,
        source_ref: r.source_ref,
        reason: r.message,
      })),
    }
    const body = JSON.stringify(summary)
    const artefact = await tx.query(
      `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
       values ('migration_summary', $1, $2, 'application/json', $3) returning id`,
      [body, createHash('sha256').update(body).digest('hex'), Buffer.byteLength(body)],
    )
    await tx.query(
      `update deedbox.migration
          set completed_at = now(), summary = $2, summary_artefact = $3
        where id = $1`,
      [input.migration, body, String(artefact.rows[0].id)],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'migration',
      subject: input.migration,
      artefact: String(artefact.rows[0].id),
      detail: { before: { completed: false }, after: { completed: true, batches: batches.rowCount } },
    })
    return { summaryArtefact: artefact.rows[0].id as number }
  })
}
