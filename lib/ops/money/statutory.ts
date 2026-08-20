// Client money statements, statutory register entries, refusal promotion
// and incident management, and the clearance interface (display mode).
// Statements render from ledger lines, number from the shipped
// `statement` purpose, and issue exactly once; statutory register entries
// take dense numbers under the per-register machinery with their typed
// values carried in the printable artefact, validated against the pack's
// register schema where one is declared; a refusal promotes to an
// incident exactly once; the incident walks open → rectified → reported
// (or straight to reported — regulators are often told before the fix).

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'
import { createHash } from 'node:crypto'

function storeArtefact(tx: Tx, kind: string, content: string) {
  return tx.query(
    `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
     values ($1, $2, $3, 'application/json', $4) returning id`,
    [kind, content, createHash('sha256').update(content).digest('hex'), Buffer.byteLength(content)],
  )
}

/** Generate a client money statement for one ledger and period. */
export async function generateClientMoneyStatement(
  p: Principal,
  input: {
    matterLedger: number
    periodStart: string
    periodEnd: string
    triggerKind?: 'periodic' | 'annual_run' | 'matter_completion' | 'on_request'
  },
): Promise<{ id: number; statementNumber: string }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.issue_statements')
    const ledger = await tx.query(
      `select ml.id, ml.ledger_number, ml.matter from deedbox.matter_ledger ml where ml.id = $1`,
      [input.matterLedger],
    )
    if (ledger.rowCount === 0) throw new OperationRefused('not_found', 'ledger not found')
    const lines = await tx.query(
      `select ll.entry_no, ll.signed_amount, ll.running_balance, t.txn_kind,
              t.effective_date::text as effective_date, t.reason
         from deedbox.ledger_line ll
         join deedbox.money_transaction t on t.id = ll.transaction
        where ll.matter_ledger = $1
          and t.effective_date between $2::date and $3::date
        order by ll.entry_no`,
      [input.matterLedger, input.periodStart, input.periodEnd],
    )
    const num = await tx.query(`select deedbox.allocate_number('statement') as n`)
    const content = JSON.stringify({
      document: 'client_money_statement',
      statement_number: num.rows[0].n,
      ledger_number: ledger.rows[0].ledger_number,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      lines: lines.rows,
      closing_balance:
        lines.rowCount! > 0 ? Number(lines.rows[lines.rowCount! - 1].running_balance) : 0,
    })
    const artefact = await storeArtefact(tx, 'client_money_statement', content)
    const r = await tx.query(
      `insert into deedbox.client_money_statement
         (matter_ledger, trigger_kind, statement_number, period_start, period_end, artefact)
       values ($1, $2, $3, $4::date, $5::date, $6) returning id`,
      [
        input.matterLedger,
        input.triggerKind ?? 'on_request',
        num.rows[0].n,
        input.periodStart,
        input.periodEnd,
        String(artefact.rows[0].id),
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'client_money_statement',
      subject: r.rows[0].id as number,
      matter: ledger.rows[0].matter as number,
      detail: { statement_number: num.rows[0].n, period_start: input.periodStart, period_end: input.periodEnd },
    })
    return { id: r.rows[0].id as number, statementNumber: num.rows[0].n as string }
  })
}

/** Issue a statement: exactly once, channel recorded, sent via the outbound queue. */
export async function issueClientMoneyStatement(
  p: Principal,
  input: { statement: number; channel: 'email' | 'print' | 'portal'; recipient?: string },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.issue_statements')
    const s = await tx.query(
      `select cms.id, cms.issued_at, cms.artefact, ml.matter
         from deedbox.client_money_statement cms
         join deedbox.matter_ledger ml on ml.id = cms.matter_ledger
        where cms.id = $1 for update of cms`,
      [input.statement],
    )
    if (s.rowCount === 0) throw new OperationRefused('not_found', 'statement not found')
    if (s.rows[0].issued_at !== null) throw new OperationRefused('issued', 'a statement issues exactly once')
    let outbound: number | null = null
    if (input.channel === 'email') {
      if (!input.recipient?.trim()) {
        throw new OperationRefused('recipient_required', 'an emailed statement names its recipient')
      }
      const ob = await tx.query(
        `insert into deedbox.outbound_message
           (channel, recipient, rendered_artefact, purpose, related_type, related)
         values ('email', $1, $2, 'client_money_statement', 'client_money_statement', $3)
         returning id`,
        [input.recipient, s.rows[0].artefact, input.statement],
      )
      outbound = ob.rows[0].id as number
    }
    await tx.query(
      `update deedbox.client_money_statement
          set issued_at = now(), issue_channel = $2, outbound_message = $3
        where id = $1`,
      [input.statement, input.channel, outbound],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'client_money_statement',
      subject: input.statement,
      matter: s.rows[0].matter as number,
      detail: { issued: true, channel: input.channel },
    })
  })
}

/**
 * Append a statutory register entry. The register row
 * materialises lazily for the active pack version's declared key; values
 * validate against the declaration's column definitions and travel in the
 * printable artefact; the schema assigns the dense entry number.
 */
export async function appendStatutoryRegisterEntry(
  p: Principal,
  input: { registerKey: string; values: Record<string, unknown> },
): Promise<{ register: number; entryNo: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_accounts')
    const decl = await tx.query(
      `select v.id as pack_version, d.body from deedbox.pack_declaration d
         join deedbox.firm f on f.id = $2
         join deedbox.country_pack cp on cp.id = f.country_pack
         join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
        where d.rule_point = 'registers.statutory' and d.discriminator = $1`,
      [input.registerKey, p.firm],
    )
    if (decl.rowCount === 0) {
      throw new OperationRefused(
        'register_undeclared',
        `the active pack declares no statutory register ${input.registerKey}`,
      )
    }
    const body = decl.rows[0].body as { name?: string; columns?: { key: string; required?: boolean }[] }
    for (const col of body.columns ?? []) {
      if (col.required && (input.values[col.key] === undefined || input.values[col.key] === '')) {
        throw new OperationRefused('incomplete', `the register requires the ${col.key} value`)
      }
    }
    for (const given of Object.keys(input.values)) {
      if (body.columns && !body.columns.some((c) => c.key === given)) {
        throw new OperationRefused('unknown_field', `the register declares no ${given} column`)
      }
    }
    const existing = await tx.query(
      `select id from deedbox.statutory_register where pack_version = $1 and register_key = $2`,
      [decl.rows[0].pack_version, input.registerKey],
    )
    let registerId: number
    if (existing.rowCount! > 0) {
      registerId = existing.rows[0].id as number
    } else {
      const r = await tx.query(
        `insert into deedbox.statutory_register (pack_version, register_key, name)
         values ($1, $2, $3) returning id`,
        [decl.rows[0].pack_version, input.registerKey, body.name ?? input.registerKey],
      )
      registerId = r.rows[0].id as number
    }
    // the per-register serialisation: entries of one register are dense
    await tx.query(`select pg_advisory_xact_lock(4203, $1::int)`, [registerId])
    const content = JSON.stringify({
      document: 'statutory_register_entry',
      register_key: input.registerKey,
      values: input.values,
    })
    const artefact = await storeArtefact(tx, 'statutory_register_entry', content)
    const e = await tx.query(
      `insert into deedbox.statutory_register_entry (register, printable_artefact)
       values ($1, $2) returning entry_no`,
      [registerId, String(artefact.rows[0].id)],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'statutory_register_entry',
      subject: registerId,
      artefact: String(artefact.rows[0].id),
      detail: { register_key: input.registerKey, entry_no: e.rows[0].entry_no },
    })
    return { register: registerId, entryNo: e.rows[0].entry_no as number }
  })
}

/** Promote a captured refusal to an incident, exactly once. */
export async function promoteRefusalToIncident(
  p: Principal,
  input: { refusal: number; narrative: string },
): Promise<{ incident: number }> {
  requireStaff(p)
  if (!input.narrative.trim()) {
    throw new OperationRefused('narrative_required', 'an incident carries its narrative')
  }
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_incidents')
    const r = await tx.query(
      `select id, account, matter_ledger, attempted_operation, refusal_reason, promoted_incident, at
         from deedbox.refused_operation where id = $1 for update`,
      [input.refusal],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_found', 'refusal not found')
    if (r.rows[0].promoted_incident !== null) {
      throw new OperationRefused('promoted', 'a refusal promotes exactly once')
    }
    const attempted = r.rows[0].attempted_operation as { operation?: string; message?: string }
    const inc = await tx.query(
      `insert into deedbox.deficiency_incident
         (account, matter_ledger, incident_date, amount, cause, narrative, origin)
       values ($1, $2, current_date, 0, $3, $4, 'promoted_refusal') returning id`,
      [
        r.rows[0].account,
        r.rows[0].matter_ledger,
        `${r.rows[0].refusal_reason}: ${attempted.message ?? attempted.operation ?? 'refused operation'}`,
        input.narrative,
      ],
    )
    await tx.query(
      `update deedbox.refused_operation set promoted_incident = $2 where id = $1`,
      [input.refusal, inc.rows[0].id],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'deficiency_incident',
      subject: inc.rows[0].id as number,
      detail: { origin: 'promoted_refusal', refusal: input.refusal },
    })
    return { incident: inc.rows[0].id as number }
  })
}

/** Record rectification (names at least one correcting transaction). */
export async function rectifyIncident(
  p: Principal,
  input: { incident: number; correctingTransactions: number[]; note: string },
): Promise<void> {
  requireStaff(p)
  if (input.correctingTransactions.length === 0) {
    throw new OperationRefused('transactions_required', 'rectification names at least one correcting transaction')
  }
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_incidents')
    const r = await tx.query(
      `update deedbox.deficiency_incident
          set state = case when state = 'open' then 'rectified' else state end,
              rectification = coalesce(rectification, '{}'::jsonb)
                || jsonb_build_object('transactions', $2::jsonb, 'note', $3::text, 'recorded_at', now())
        where id = $1 and state in ('open','rectified','reported')
        returning state`,
      [input.incident, JSON.stringify(input.correctingTransactions), input.note],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_found', 'incident not found')
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'deficiency_incident',
      subject: input.incident,
      detail: { rectification_recorded: true, transactions: input.correctingTransactions },
    })
  })
}

/** Report an incident: the notification artefact from the pack shape; terminal. */
export async function reportIncident(p: Principal, input: { incident: number }): Promise<{ artefact: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_incidents')
    const r = await tx.query(
      `select id, account, matter_ledger, incident_date::text as d, amount, cause, narrative, state
         from deedbox.deficiency_incident where id = $1 for update`,
      [input.incident],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_found', 'incident not found')
    if (r.rows[0].state === 'reported') throw new OperationRefused('reported', 'the incident is already reported')
    const content = JSON.stringify({
      document: 'incident_notification',
      incident: input.incident,
      incident_date: r.rows[0].d,
      account: r.rows[0].account,
      amount: Number(r.rows[0].amount),
      cause: r.rows[0].cause,
      narrative: r.rows[0].narrative,
    })
    const artefact = await storeArtefact(tx, 'incident_notification', content)
    await tx.query(
      `update deedbox.deficiency_incident
          set state = 'reported', notification_artefact = $2
        where id = $1`,
      [input.incident, String(artefact.rows[0].id)],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'deficiency_incident',
      subject: input.incident,
      privileged: true,
      artefact: String(artefact.rows[0].id),
      detail: { before: { state: r.rows[0].state }, after: { state: 'reported' } },
    })
    return { artefact: artefact.rows[0].id as number }
  })
}

/** Clearance display mode — per-ledger clearance position, warnings only for dormancy. */
export async function matterMoneyClearance(
  p: Principal,
  input: { matter: number },
): Promise<{
  ledgers: {
    ledger: number
    balance: number
    activeEarmarks: number
    outstandingInstruments: number
    dormantWarning: boolean
  }[]
}> {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select ml.id,
                deedbox.ledger_balance(ml.id) as balance,
                deedbox.ledger_active_earmarks(ml.id) as marked,
                (select count(*)::int from deedbox.instrument i
                  where i.state in ('created','stale','received','banked')
                    and exists (select 1 from deedbox.ledger_line ll
                                 where ll.transaction = i.transaction and ll.matter_ledger = ml.id)) as instruments,
                exists (select 1 from deedbox.dormant_case dc
                         where dc.matter_ledger = ml.id and dc.state in ('open','contact_in_progress')) as dormant
           from deedbox.matter_ledger ml
          where ml.matter = $1 and ml.ledger_kind = 'client_matter'
          order by ml.id`,
        [input.matter],
      )
      return {
        ledgers: r.rows.map((row) => ({
          ledger: row.id as number,
          balance: Number(row.balance),
          activeEarmarks: Number(row.marked),
          outstandingInstruments: row.instruments as number,
          dormantWarning: row.dormant as boolean,
        })),
      }
    },
    { readOnly: true },
  )
}
