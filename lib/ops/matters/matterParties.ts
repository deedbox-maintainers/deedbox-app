// Matter parties, client change, relations. The automatic client row is
// trigger-maintained and cannot be forged or removed here (0006's guard);
// portal-access changes are privileged register events because they change
// external visibility.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, clientOnLedgerBearingMatter, shippedChoiceItem } from '@/lib/ops/shared'

export async function addMatterParty(
  p: Principal,
  input: { matter: number; party: number; capacity: number; note?: string; portalAccess?: boolean },
): Promise<{ id: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const m = await tx.query(`select id from deedbox.matter where id = $1 for update`, [input.matter])
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
    const party = await tx.query(
      `select state, deleted_at from deedbox.party where id = $1`,
      [input.party],
    )
    if (party.rowCount === 0) throw new OperationRefused('not_found', 'party not found')
    if (party.rows[0].state !== 'active' || party.rows[0].deleted_at !== null) {
      throw new OperationRefused('party_inactive', 'only active parties join matters')
    }
    const clientCap = await shippedChoiceItem(tx, 'matter_party_capacities', 'client')
    if (input.capacity === clientCap) {
      throw new OperationRefused(
        'client_capacity_reserved',
        'the client row follows the matter’s client and is never added by hand',
      )
    }
    const dup = await tx.query(
      `select 1 from deedbox.matter_party
        where matter = $1 and party = $2 and capacity = $3 and deleted_at is null`,
      [input.matter, input.party, input.capacity],
    )
    if (dup.rowCount! > 0) throw new OperationRefused('already_on_matter', 'this party already holds this capacity')

    const r = await tx.query(
      `insert into deedbox.matter_party (matter, party, capacity, note, portal_access)
       values ($1,$2,$3,$4,$5) returning id`,
      [input.matter, input.party, input.capacity, input.note ?? null, input.portalAccess ?? false],
    )
    const id = r.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'matter_party',
      subject: id,
      matter: input.matter,
      detail: { party: input.party, capacity: input.capacity },
    })
    if (input.portalAccess) {
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'matter_party',
        subject: id,
        matter: input.matter,
        privileged: true,
        detail: { before: { portal_access: false }, after: { portal_access: true } },
      })
    }
    return { id }
  })
}

export async function setPortalAccess(
  p: Principal,
  input: { matterParty: number; portalAccess: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.matter_party set portal_access = $2
        where id = $1 and deleted_at is null and portal_access is distinct from $2
        returning matter, portal_access`,
      [input.matterParty, input.portalAccess],
    )
    if (r.rowCount === 0) {
      throw new OperationRefused('no_change', 'matter party not found or access already as requested')
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter_party',
      subject: input.matterParty,
      matter: r.rows[0].matter as number,
      privileged: true,
      detail: {
        before: { portal_access: !input.portalAccess },
        after: { portal_access: input.portalAccess },
      },
    })
  })
}

export async function softDeleteMatterParty(
  p: Principal,
  input: { matterParty: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const row = await tx.query(
      `select mp.matter, mp.party, mp.capacity from deedbox.matter_party mp
        where mp.id = $1 and mp.deleted_at is null for update`,
      [input.matterParty],
    )
    if (row.rowCount === 0) throw new OperationRefused('not_found', 'matter party not found')
    // The schema's client guard refuses removing the client row; a typed
    // message beats a raw guard error on the screen.
    const clientCap = await shippedChoiceItem(tx, 'matter_party_capacities', 'client')
    if (row.rows[0].capacity === clientCap) {
      throw new OperationRefused(
        'client_row_protected',
        'the client row follows the matter’s client; change the client instead',
      )
    }
    await tx.query(
      `update deedbox.matter_party set deleted_at = now(), deleted_by = $2 where id = $1`,
      [input.matterParty, p.id],
    )
    await emitRegister(tx, p, {
      kind: 'record.soft_deleted',
      subjectType: 'matter_party',
      subject: input.matterParty,
      matter: row.rows[0].matter as number,
      detail: { party: row.rows[0].party },
    })
  })
}

/**
 * Client change: open/on_hold matters only, never to a merged party.
 * The trigger maintains the party rows (old client demotes to related_party,
 * new client row installed); existing bills keep their payer parties.
 */
export async function changeClient(
  p: Principal,
  input: { matter: number; newClient: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const m = await tx.query(
      `select status, client_party from deedbox.matter where id = $1 for update`,
      [input.matter],
    )
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
    if (m.rows[0].status !== 'open' && m.rows[0].status !== 'on_hold') {
      throw new OperationRefused('wrong_status', 'the client changes only on open or on-hold matters')
    }
    const before = m.rows[0].client_party as number
    if (before === input.newClient) {
      throw new OperationRefused('no_change', 'this party is already the client')
    }
    const party = await tx.query(
      `select state, deleted_at from deedbox.party where id = $1`,
      [input.newClient],
    )
    if (party.rowCount === 0) throw new OperationRefused('not_found', 'party not found')
    if (party.rows[0].state !== 'active' || party.rows[0].deleted_at !== null) {
      throw new OperationRefused('party_inactive', 'the new client must be an active party')
    }
    await tx.query(`update deedbox.matter set client_party = $2 where id = $1`, [
      input.matter,
      input.newClient,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter',
      subject: input.matter,
      matter: input.matter,
      detail: { before: { client_party: before }, after: { client_party: input.newClient } },
    })
    const hasLedger = await tx.query(
      `select exists (select 1 from deedbox.matter_ledger where matter = $1) as ok`,
      [input.matter],
    )
    if (hasLedger.rows[0].ok) {
      await emitRegister(tx, p, {
        kind: 'master_data.changed',
        subjectType: 'matter',
        subject: input.matter,
        matter: input.matter,
        detail: { field: 'client', before, after: input.newClient },
      })
    }
  })
}
