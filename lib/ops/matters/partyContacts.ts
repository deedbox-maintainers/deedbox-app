// Contact points and addresses. One transaction per save; setting a primary
// clears the previous primary (the party mirror follows by trigger); match
// keys rebuild by trigger on phone/email changes. master_data.changed emits
// for ADDRESS writes on ledger-bearing clients — names and addresses are the
// statutory master data; phone/email are not (recorded implementation
// choice).

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, clientOnLedgerBearingMatter } from '@/lib/ops/shared'

async function lockActiveParty(tx: Tx, partyId: number): Promise<void> {
  const r = await tx.query(
    `select state, deleted_at from deedbox.party where id = $1 for update`,
    [partyId],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'party not found')
  if (r.rows[0].state !== 'active' || r.rows[0].deleted_at !== null) {
    throw new OperationRefused('party_inactive', 'this party is not active')
  }
}

export async function addContactPoint(
  p: Principal,
  input: { party: number; kind: 'phone' | 'email'; value: string; label?: string; primary?: boolean },
): Promise<{ id: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await lockActiveParty(tx, input.party)
    if (input.primary) {
      await tx.query(
        `update deedbox.contact_point set is_primary = false
          where party = $1 and kind = $2 and is_primary and deleted_at is null`,
        [input.party, input.kind],
      )
    }
    const r = await tx.query(
      `insert into deedbox.contact_point (party, kind, value, label, is_primary)
       values ($1, $2, $3, $4, $5) returning id`,
      [input.party, input.kind, input.value, input.label ?? null, input.primary ?? false],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'party',
      subject: input.party,
      detail: { added_contact: { kind: input.kind, value: input.value, primary: input.primary ?? false } },
    })
    return { id: r.rows[0].id as number }
  })
}

export async function softDeleteContactPoint(
  p: Principal,
  input: { party: number; contactPoint: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await lockActiveParty(tx, input.party)
    const r = await tx.query(
      `update deedbox.contact_point
          set deleted_at = now(), deleted_by = $3, is_primary = false
        where id = $1 and party = $2 and deleted_at is null
        returning kind, value`,
      [input.contactPoint, input.party, p.id],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_found', 'contact point not found')
    await emitRegister(tx, p, {
      kind: 'record.soft_deleted',
      subjectType: 'party',
      subject: input.party,
      detail: { removed_contact: { kind: r.rows[0].kind, value: r.rows[0].value } },
    })
  })
}

export async function addAddress(
  p: Principal,
  input: {
    party: number
    kind?: 'postal' | 'street' | 'billing' | 'other'
    lines?: string
    locality?: string
    region?: string
    postcode?: string
    country?: string
  },
): Promise<{ id: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await lockActiveParty(tx, input.party)
    const r = await tx.query(
      `insert into deedbox.postal_address (party, kind, lines, locality, region, postcode, country)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        input.party,
        input.kind ?? 'postal',
        input.lines ?? null,
        input.locality ?? null,
        input.region ?? null,
        input.postcode ?? null,
        input.country ?? null,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'party',
      subject: input.party,
      detail: { added_address: { kind: input.kind ?? 'postal', locality: input.locality ?? null } },
    })
    if (await clientOnLedgerBearingMatter(tx, input.party)) {
      await emitRegister(tx, p, {
        kind: 'master_data.changed',
        subjectType: 'party',
        subject: input.party,
        detail: { field: 'address', added: { kind: input.kind ?? 'postal' } },
      })
    }
    return { id: r.rows[0].id as number }
  })
}
