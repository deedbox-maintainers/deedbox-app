// Examiner grants: the delegating grant/revoke and the examination pack export.
//
// Implementation notes:
//   * The examiner credential is generated here like an integration key: shown once,
//     only its hash stored.
//   * The pack export assembles the bundle for the period — every money transaction
//     with its lines, grouped per ledger under the fixed minimal header (ledger number,
//     client display name, matter reference) — stores the exact artefact, writes the
//     examination_pack_export row and the privileged export.performed entry carrying the
//     restricted-matter count.
//   * The examiner path is LIVE (schema change 0025): the row policies scope every read
//     to the grant's examined period, identity comes only through
//     deedbox.examiner_ledger_header, the requested period must sit inside the grant's,
//     and the examination_pack_export row records the examiner as the exporter. Per-read
//     registration for the workspace's screens lives in examinerReads.ts; the export's
//     own register entry is export.performed.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireCapability } from '@/lib/ops/shared'

/** Grant: the secret exists nowhere after this call. */
export async function grantExaminer(
  p: Principal,
  input: {
    examinerName: string
    login: string
    periodStart: string
    periodEnd: string
    startsAt: string
    expiresAt: string
  },
): Promise<{ id: number; secret: string }> {
  if (!input.examinerName.trim() || !input.login.trim()) {
    throw new OperationRefused('incomplete', 'an examiner grant names the examiner and their login')
  }
  const secret = randomBytes(32).toString('base64url')
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.grant_examiner')
    const r = await tx.query(
      `insert into deedbox.examiner_grant
         (examiner_name, login, secret_hash, period_start, period_end, starts_at, expires_at, granted_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        input.examinerName.trim(),
        input.login.trim(),
        createHash('sha256').update(secret).digest('hex'),
        input.periodStart,
        input.periodEnd,
        input.startsAt,
        input.expiresAt,
        p.id,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'examiner.granted',
      subjectType: 'examiner_grant',
      subject: r.rows[0].id as number,
      privileged: true,
      detail: {
        before: null,
        after: {
          examiner_name: input.examinerName.trim(),
          login: input.login.trim(),
          period: { start: input.periodStart, end: input.periodEnd },
          window: { starts_at: input.startsAt, expires_at: input.expiresAt },
        },
      },
    })
    return { id: r.rows[0].id as number, secret }
  })
}

/** Revoke: reason required; sessions end in the same transaction. */
export async function revokeExaminer(
  p: Principal,
  input: { grant: number; reason: string },
): Promise<{ endedSessions: number }> {
  if (!input.reason?.trim()) {
    throw new OperationRefused('reason_required', 'revoking an examiner grant carries a reason')
  }
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.grant_examiner')
    const cur = await tx.query(
      `select id, examiner_name, login, revoked_at from deedbox.examiner_grant where id = $1 for update`,
      [input.grant],
    )
    if (cur.rowCount === 0) throw new OperationRefused('not_found', 'examiner grant not found')
    if (cur.rows[0].revoked_at !== null) {
      throw new OperationRefused('already_revoked', 'this grant is already revoked')
    }
    await tx.query(
      `update deedbox.examiner_grant set revoked_at = now(), revoked_by = $2 where id = $1`,
      [input.grant, p.id],
    )
    const sessions = await tx.query(
      `select id from deedbox.session where examiner_grant = $1 and ended_at is null order by id`,
      [input.grant],
    )
    let endedSessions = 0
    for (const s of sessions.rows) {
      await tx.query(
        `update deedbox.session set ended_at = now(), end_reason = 'grant_expired' where id = $1`,
        [s.id],
      )
      await emitRegister(tx, p, {
        kind: 'session.ended',
        subjectType: 'session',
        subject: s.id as number,
        detail: { reason: 'grant_expired', revocation: input.grant },
      })
      endedSessions++
    }
    await emitRegister(tx, p, {
      kind: 'examiner.revoked',
      subjectType: 'examiner_grant',
      subject: input.grant,
      privileged: true,
      reason: input.reason,
      detail: {
        before: { revoked: false, login: cur.rows[0].login },
        after: { revoked: true, sessions_ended: endedSessions },
      },
    })
    return { endedSessions }
  })
}

/** Examiner sign-in: credential + window; the session is the scope's anchor. */
export async function examinerSignIn(input: {
  login: string
  secret: string
  firm: number
  device: { fingerprint: string; label?: string }
}): Promise<{ session: number; grant: number }> {
  const system: Principal = { kind: 'system_job', id: 0, firm: input.firm }
  return withPrincipal(system, async (tx) => {
    const g = await tx.query(
      `select id, secret_hash from deedbox.examiner_grant
        where login = $1 and revoked_at is null
          and now() >= starts_at and now() < expires_at`,
      [input.login],
    )
    const presented = createHash('sha256').update(input.secret).digest('hex')
    const stored = g.rowCount! > 0 ? (g.rows[0].secret_hash as string) : ''
    const ok =
      g.rowCount! > 0 &&
      stored.length === presented.length &&
      timingSafeEqual(Buffer.from(stored, 'utf8'), Buffer.from(presented, 'utf8'))
    if (!ok) {
      throw new OperationRefused('unauthenticated', 'examiner credentials refused')
    }
    const grantId = g.rows[0].id as number
    const dev = await tx.query(
      `insert into deedbox.device (owner_kind, owner, fingerprint, label)
       values ('examiner', $1, $2, $3)
       on conflict (owner_kind, owner, fingerprint)
         do update set last_seen = now()
       returning id`,
      [grantId, input.device.fingerprint, input.device.label ?? null],
    )
    const sess = await tx.query(
      `insert into deedbox.session (principal_kind, principal, device, examiner_grant)
       values ('examiner', $1, $2, $1) returning id`,
      [grantId, dev.rows[0].id],
    )
    const actor: Principal = {
      kind: 'examiner',
      id: grantId,
      firm: input.firm,
      session: sess.rows[0].id as number,
    }
    await emitRegister(tx, actor, {
      kind: 'signin.succeeded',
      subjectType: 'session',
      subject: sess.rows[0].id as number,
      detail: { examiner_grant: grantId, device: dev.rows[0].id },
    })
    return { session: sess.rows[0].id as number, grant: grantId }
  })
}

/** The expiry job: end sessions of expired grants with the honest reason. */
export async function runExaminerExpiry(p: Principal): Promise<{ ended: number }> {
  return withPrincipal(p, async (tx) => {
    const stale = await tx.query(
      `select s.id from deedbox.session s
         join deedbox.examiner_grant g on g.id = s.examiner_grant
        where s.ended_at is null
          and (g.expires_at <= now() or g.revoked_at is not null)
        order by s.id`,
    )
    let ended = 0
    for (const s of stale.rows) {
      await tx.query(
        `update deedbox.session set ended_at = now(), end_reason = 'grant_expired' where id = $1`,
        [s.id],
      )
      await emitRegister(tx, p, {
        kind: 'session.ended',
        subjectType: 'session',
        subject: s.id as number,
        detail: { reason: 'grant_expired' },
      })
      ended++
    }
    return { ended }
  })
}

/** The examination pack: exact artefact, examination_pack_export row, privileged export entry. */
export async function exportExaminationPack(
  p: Principal,
  input: { periodStart: string; periodEnd: string },
): Promise<{ artefact: number; transactions: number; restrictedMatters: number }> {
  return withPrincipal(p, async (tx) => {
    if (p.kind === 'staff') {
      await requireCapability(tx, p, 'money.examination_export')
    } else if (p.kind === 'examiner') {
      // the grant must be live and the requested period inside the examined
      // period — the row policies clip reads to the grant regardless, but an
      // artefact claiming a wider period than it can serve would be a lie
      const g = await tx.query(
        `select period_start::text as ps, period_end::text as pe
           from deedbox.examiner_grant
          where id = $1 and revoked_at is null
            and now() >= starts_at and now() < expires_at`,
        [p.id],
      )
      if (g.rowCount === 0) {
        throw new OperationRefused('grant_inactive', 'this examiner grant is not currently active')
      }
      if (input.periodStart < g.rows[0].ps || input.periodEnd > g.rows[0].pe) {
        throw new OperationRefused(
          'outside_access_window',
          `the examined period runs ${g.rows[0].ps} to ${g.rows[0].pe}`,
        )
      }
    } else {
      throw new OperationRefused('staff_only', 'the pack is exported by staff or an active examiner')
    }

    // staff read identity through the ordinary predicate joins; the examiner
    // reads it only through the definer header pinhole (0025), with the row
    // policies scoping every line to the examined period
    const ledgers =
      p.kind === 'examiner'
        ? await tx.query(
            `select ml.id, h.ledger_number, h.matter_reference as matter_number,
                    h.client_display_name as client_name, h.restricted
               from deedbox.matter_ledger ml
               cross join lateral deedbox.examiner_ledger_header(ml.id) h
              where exists (
                select 1 from deedbox.ledger_line l
                  join deedbox.money_transaction t on t.id = l.transaction
                 where l.matter_ledger = ml.id
                   and t.effective_date between $1::date and $2::date)
              order by ml.id`,
            [input.periodStart, input.periodEnd],
          )
        : await tx.query(
            `select ml.id, ml.ledger_number, m.matter_number, p2.display_name as client_name, m.restricted
               from deedbox.matter_ledger ml
               join deedbox.matter m on m.id = ml.matter
               join deedbox.party p2 on p2.id = m.client_party
              where exists (
                select 1 from deedbox.ledger_line l
                  join deedbox.money_transaction t on t.id = l.transaction
                 where l.matter_ledger = ml.id
                   and t.effective_date between $1::date and $2::date)
              order by ml.id`,
            [input.periodStart, input.periodEnd],
          )
    let transactions = 0
    const bundle: unknown[] = []
    for (const led of ledgers.rows) {
      const txns = await tx.query(
        `select t.id, t.txn_kind, t.effective_date, t.entered_at, t.source_entered_at, t.reason,
                l.signed_amount, l.entry_no, l.running_balance
           from deedbox.ledger_line l
           join deedbox.money_transaction t on t.id = l.transaction
          where l.matter_ledger = $1
            and t.effective_date between $2::date and $3::date
          order by l.entry_no`,
        [led.id, input.periodStart, input.periodEnd],
      )
      transactions += txns.rowCount!
      bundle.push({
        header: {
          ledger_number: led.ledger_number,
          client_display_name: led.client_name,
          matter_reference: led.matter_number,
        },
        movements: txns.rows,
      })
    }
    const restricted = ledgers.rows.filter((l) => l.restricted).length
    const content = JSON.stringify({
      examination_pack: { period: { start: input.periodStart, end: input.periodEnd } },
      ledgers: bundle,
    })
    const artefact = await tx.query(
      `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
       values ('examination_pack', $1, $2, 'application/json', $3) returning id`,
      [content, createHash('sha256').update(content).digest('hex'), Buffer.byteLength(content)],
    )
    await tx.query(
      `insert into deedbox.examination_pack_export (period, exported_by_kind, exported_by, artefact)
       values ($1, $2, $3, $4)`,
      [
        JSON.stringify({ start: input.periodStart, end: input.periodEnd }),
        p.kind === 'examiner' ? 'examiner' : 'staff',
        p.id,
        String(artefact.rows[0].id),
      ],
    )
    await emitRegister(tx, p, {
      kind: 'export.performed',
      subjectType: 'examination_pack_export',
      subject: artefact.rows[0].id as number,
      privileged: true,
      artefact: String(artefact.rows[0].id),
      detail: {
        before: null,
        after: {
          period: { start: input.periodStart, end: input.periodEnd },
          ledgers: ledgers.rowCount,
          transactions,
          restricted_matters: restricted,
        },
      },
    })
    return {
      artefact: artefact.rows[0].id as number,
      transactions,
      restrictedMatters: restricted,
    }
  })
}
