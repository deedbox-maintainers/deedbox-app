// Activity signals and the suggestion queue. Nothing reaches billing
// unreviewed: only acceptance creates a time entry, and the resolver never
// proposes a matter outside the staff member's predicate.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { createTimeEntryInTx } from './timeEntries'

export interface SignalInput {
  sourceModule: string
  signalKind: 'email_sent' | 'document_worked' | 'appointment_held' | 'call_logged' | 'other'
  sourceRef: string
  occurredAt: string
  staff?: number
  matterHint?: number
  durationMinutes?: number
  detail?: unknown
}

/** Is the matter visible to the SUGGESTION'S staff member (not the caller)? */
async function visibleToStaff(tx: Tx, staffId: number, matterId: number): Promise<boolean> {
  const r = await tx.query(`select deedbox.matter_visible('staff', $1, $2) as ok`, [
    staffId,
    matterId,
  ])
  return r.rows[0].ok as boolean
}

/** Ingest a signal (module/interface principals). Idempotent by source. */
export async function ingestSignal(
  p: Principal,
  input: SignalInput,
): Promise<{ signal: number | null; suggestion: number | null }> {
  if (p.kind !== 'system_job' && p.kind !== 'integration_key') {
    throw new OperationRefused('module_only', 'signals arrive through module principals')
  }
  return withPrincipal(p, async (tx) => {
    const dup = await tx.query(
      `select id from deedbox.activity_signal where source_module = $1 and source_ref = $2`,
      [input.sourceModule, input.sourceRef],
    )
    if (dup.rowCount! > 0) return { signal: null, suggestion: null } // replay: success, no write

    const sig = await tx.query(
      `insert into deedbox.activity_signal
         (source_module, signal_kind, source_ref, occurred_at, staff, matter_hint,
          duration_hint_minutes, detail)
       values ($1,$2,$3,$4::timestamptz,$5,$6,$7,$8) returning id`,
      [
        input.sourceModule,
        input.signalKind,
        input.sourceRef,
        input.occurredAt,
        input.staff ?? null,
        input.matterHint === undefined ? null : JSON.stringify({ matter: input.matterHint }),
        input.durationMinutes ?? null,
        JSON.stringify(input.detail ?? {}),
      ],
    )
    const signalId = sig.rows[0].id as number
    if (input.staff === undefined) {
      return { signal: signalId, suggestion: null } // no staff, no queue entry
    }

    // the resolver: an explicit hint that passes the STAFF MEMBER'S predicate,
    // else held for manual assignment — never lost, never leaking
    let matter: number | null = null
    if (input.matterHint !== undefined) {
      if (await visibleToStaff(tx, input.staff, input.matterHint)) {
        matter = input.matterHint
      }
    }
    const sug = await tx.query(
      `insert into deedbox.suggested_entry
         (signal, staff, matter, state, proposed_date, proposed_minutes, proposed_narrative)
       values ($1, $2, $3, $4, $5::date, $6, $7) returning id`,
      [
        signalId,
        input.staff,
        matter,
        matter === null ? 'held_unmatched' : 'pending',
        input.occurredAt.slice(0, 10),
        input.durationMinutes ?? 6,
        `${input.signalKind.replace(/_/g, ' ')} — ${input.sourceModule}`,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'suggested_entry',
      subject: sug.rows[0].id as number,
      matter: matter ?? undefined,
      detail: { signal: signalId, state: matter === null ? 'held_unmatched' : 'pending' },
    })
    return { signal: signalId, suggestion: sug.rows[0].id as number }
  })
}

/** Assign a matter to a held suggestion. */
export async function assignSuggestionMatter(
  p: Principal,
  input: { suggestion: number; matter: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const s = await tx.query(
      `select staff, state from deedbox.suggested_entry where id = $1 for update`,
      [input.suggestion],
    )
    if (s.rowCount === 0) throw new OperationRefused('not_found', 'suggestion not found')
    if (s.rows[0].state !== 'held_unmatched') {
      throw new OperationRefused('not_held', 'only held suggestions take a matter assignment')
    }
    // visible to the assigner (row security) AND to the suggestion's staff
    const mine = await tx.query(`select 1 from deedbox.matter where id = $1`, [input.matter])
    if (mine.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
    if (!(await visibleToStaff(tx, s.rows[0].staff as number, input.matter))) {
      throw new OperationRefused(
        'staff_cannot_see',
        'the suggestion’s staff member cannot see that matter',
      )
    }
    await tx.query(
      `update deedbox.suggested_entry set matter = $2, state = 'pending' where id = $1`,
      [input.suggestion, input.matter],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'suggested_entry',
      subject: input.suggestion,
      matter: input.matter,
      detail: { state: { before: 'held_unmatched', after: 'pending' } },
    })
  })
}

/** Accept (optionally edited): the one exit that creates a time entry. */
export async function acceptSuggestion(
  p: Principal,
  input: {
    suggestion: number
    units?: number
    narrative?: string
    workDate?: string
    category?: number
    manualRate?: number
  },
): Promise<{ entry: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const s = await tx.query(
      `select * from deedbox.suggested_entry where id = $1 for update`,
      [input.suggestion],
    )
    if (s.rowCount === 0) throw new OperationRefused('not_found', 'suggestion not found')
    const sug = s.rows[0]
    if (sug.state !== 'pending') {
      throw new OperationRefused('not_pending', 'only pending suggestions are accepted')
    }
    const edited =
      input.units !== undefined ||
      input.narrative !== undefined ||
      input.workDate !== undefined ||
      input.category !== undefined
    const minutes = input.units !== undefined ? null : (sug.proposed_minutes as number)
    const unitMinutes = await tx.query(
      `select (deedbox.current_setting_value('time.unit_minutes') #>> '{}')::int as u`,
    )
    const units =
      input.units ?? Math.max(1, Math.ceil((minutes as number) / (unitMinutes.rows[0].u as number)))

    const entry = await createTimeEntryInTx(tx, p, {
      matter: sug.matter as number,
      staff: sug.staff as number,
      workDate: input.workDate ?? (sug.proposed_date as string),
      units,
      narrative: input.narrative ?? (sug.proposed_narrative as string),
      category: input.category,
      manualRate: input.manualRate,
      origin: 'suggestion',
      suggestion: input.suggestion,
    })
    await tx.query(
      `update deedbox.suggested_entry
          set state = $2, resulting_entry = $3, resolved_at = now()
        where id = $1`,
      [input.suggestion, edited ? 'edited_accepted' : 'accepted', entry.id],
    )
    return { entry: entry.id }
  })
}

/** Merge into an existing entry. */
export async function mergeSuggestion(
  p: Principal,
  input: { suggestion: number; intoEntry: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const s = await tx.query(
      `select state from deedbox.suggested_entry where id = $1 for update`,
      [input.suggestion],
    )
    if (s.rowCount === 0) throw new OperationRefused('not_found', 'suggestion not found')
    if (s.rows[0].state !== 'pending') {
      throw new OperationRefused('not_pending', 'only pending suggestions merge')
    }
    const e = await tx.query(
      `select 1 from deedbox.time_entry where id = $1 and deleted_at is null`,
      [input.intoEntry],
    )
    if (e.rowCount === 0) throw new OperationRefused('not_found', 'target entry not found')
    await tx.query(
      `update deedbox.suggested_entry
          set state = 'merged', merged_into_entry = $2, resolved_at = now()
        where id = $1`,
      [input.suggestion, input.intoEntry],
    )
  })
}

/**
 * Discard; the evidence row is retained. Pending only: a discarded
 * row carries its matter by schema rule, so a held (matterless) suggestion
 * is assigned first or left held — never silently dropped.
 */
export async function discardSuggestion(
  p: Principal,
  input: { suggestion: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.suggested_entry set state = 'discarded', resolved_at = now()
        where id = $1 and state = 'pending'
        returning id`,
      [input.suggestion],
    )
    if (r.rowCount === 0) {
      throw new OperationRefused('not_pending', 'only pending suggestions are discarded')
    }
  })
}
