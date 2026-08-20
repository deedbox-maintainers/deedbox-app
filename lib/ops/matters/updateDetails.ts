// Amend a matter's own words — the title and the summary. The register
// carries before/after; the search corpus re-indexes by trigger. A matter
// that is no longer open keeps its details as part of its record — reopen
// it first (typed refusal, never a silent block).

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'

export async function updateMatterDetails(
  p: Principal,
  input: { matter: number; title?: string; summary?: string | null },
): Promise<void> {
  requireStaff(p)
  const title = input.title?.trim()
  if (input.title !== undefined && !title) {
    throw new OperationRefused('title_required', 'a matter keeps a title')
  }
  if (input.title === undefined && input.summary === undefined) return
  await withPrincipal(p, async (tx) => {
    const m = await tx.query(
      `select id, status, title, summary from deedbox.matter where id = $1 for update`,
      [input.matter],
    )
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
    const cur = m.rows[0]
    if (!['open', 'on_hold'].includes(cur.status as string)) {
      throw new OperationRefused(
        'matter_not_open',
        `a ${cur.status} matter's details are part of its record — reopen it first`,
      )
    }
    const nextTitle = title ?? (cur.title as string)
    const nextSummary = input.summary === undefined ? (cur.summary as string | null) : input.summary
    if (nextTitle === cur.title && nextSummary === cur.summary) return
    await tx.query(`update deedbox.matter set title = $2, summary = $3 where id = $1`, [
      input.matter,
      nextTitle,
      nextSummary,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter',
      subject: input.matter,
      matter: input.matter,
      detail: {
        before: { title: cur.title, summary: cur.summary },
        after: { title: nextTitle, summary: nextSummary },
      },
    })
  })
}
