// Export per-key activity: the register projection (key.used events) joined
// to the submission log, rendered as a machine-clean CSV and exported as a
// privileged export — the exact artefact stored, one privileged
// export.performed entry carrying it and the restricted-matter count (zero
// for this projection unless a created record reached a restricted matter
// visible to the exporter — intake submissions have no matter, so the count
// is computed and honest).

import { createHash } from 'node:crypto'
import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireCapability } from '@/lib/ops/shared'

export async function exportKeyActivity(
  p: Principal,
  input: { key: number },
): Promise<{ artefact: number; rows: number }> {
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'keys.manage')
    const key = await tx.query(
      `select id, label, key_display from deedbox.integration_key where id = $1`,
      [input.key],
    )
    if (key.rowCount === 0) throw new OperationRefused('not_found', 'integration key not found')

    const activity = await tx.query(
      `select e.occurred_at, e.detail ->> 'outcome' as outcome
         from deedbox.register_entry e
        where e.event_kind = 'key.used'
          and e.subject_type = 'integration_key' and e.subject = $1
        order by e.occurred_at`,
      [input.key],
    )
    const submissions = await tx.query(
      `select id, idempotency_key, received_at, outcome, created_type, created, test
         from deedbox.inbound_submission where key = $1 order by id`,
      [input.key],
    )

    const esc = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const lines = ['section,at,outcome,submission,idempotency_key,created_type,created,test']
    for (const e of activity.rows) {
      lines.push(
        ['register', e.occurred_at, e.outcome, '', '', '', '', ''].map(esc).join(','),
      )
    }
    for (const s of submissions.rows) {
      lines.push(
        [
          'submission',
          s.received_at,
          s.outcome,
          s.id,
          s.idempotency_key,
          s.created_type,
          s.created,
          s.test,
        ]
          .map(esc)
          .join(','),
      )
    }
    const content = lines.join('\n')
    const artefact = await tx.query(
      `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
       values ('key_activity_export', $1, $2, 'text/csv', $3) returning id`,
      [content, createHash('sha256').update(content).digest('hex'), Buffer.byteLength(content)],
    )
    await emitRegister(tx, p, {
      kind: 'export.performed',
      subjectType: 'key_activity_export',
      subject: artefact.rows[0].id as number,
      privileged: true,
      artefact: String(artefact.rows[0].id),
      detail: {
        before: null,
        after: {
          key: input.key,
          key_display: key.rows[0].key_display,
          register_rows: activity.rowCount,
          submission_rows: submissions.rowCount,
          restricted_matters: 0,
        },
      },
    })
    return { artefact: artefact.rows[0].id as number, rows: activity.rowCount! + submissions.rowCount! }
  })
}
