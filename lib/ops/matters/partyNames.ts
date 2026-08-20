// Rename / add name. Never deletes a name; a rename demotes the current row
// to former and installs the new current row. Match keys rebuild by
// trigger. master_data.changed emits where the party is a client on a
// ledger-bearing matter.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, clientOnLedgerBearingMatter } from '@/lib/ops/shared'

export interface NameInput {
  fullName: string
  givenNames?: string
  familyName?: string
  orgName?: string
}

export async function renameParty(
  p: Principal,
  input: { party: number } & NameInput,
): Promise<void> {
  requireStaff(p)
  const fullName = input.fullName.trim()
  if (!fullName) throw new OperationRefused('name_required', 'a party needs a name')

  await withPrincipal(p, async (tx) => {
    const party = await tx.query(
      `select id, state, display_name, deleted_at from deedbox.party where id = $1 for update`,
      [input.party],
    )
    if (party.rowCount === 0) throw new OperationRefused('not_found', 'party not found')
    if (party.rows[0].state !== 'active' || party.rows[0].deleted_at !== null) {
      throw new OperationRefused('party_inactive', 'only active parties are renamed')
    }
    const before = party.rows[0].display_name as string

    await tx.query(
      `update deedbox.party_name set name_kind = 'former'
        where party = $1 and name_kind = 'current'`,
      [input.party],
    )
    await tx.query(
      `insert into deedbox.party_name (party, name_kind, full_name, given_names, family_name, org_name)
       values ($1, 'current', $2, $3, $4, $5)`,
      [input.party, fullName, input.givenNames ?? null, input.familyName ?? null, input.orgName ?? null],
    )
    await tx.query(`update deedbox.party set display_name = $2 where id = $1`, [
      input.party,
      fullName,
    ])

    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'party',
      subject: input.party,
      detail: { before: { display_name: before }, after: { display_name: fullName } },
    })
    if (await clientOnLedgerBearingMatter(tx, input.party)) {
      await emitRegister(tx, p, {
        kind: 'master_data.changed',
        subjectType: 'party',
        subject: input.party,
        detail: { field: 'name', before, after: fullName },
      })
    }
  })
}

export async function addPartyName(
  p: Principal,
  input: { party: number; nameKind: 'former' | 'also_known_as' | 'trading' } & NameInput,
): Promise<void> {
  requireStaff(p)
  const fullName = input.fullName.trim()
  if (!fullName) throw new OperationRefused('name_required', 'a name needs text')

  await withPrincipal(p, async (tx) => {
    const party = await tx.query(
      `select state, deleted_at from deedbox.party where id = $1 for update`,
      [input.party],
    )
    if (party.rowCount === 0) throw new OperationRefused('not_found', 'party not found')
    if (party.rows[0].state !== 'active' || party.rows[0].deleted_at !== null) {
      throw new OperationRefused('party_inactive', 'only active parties take new names')
    }
    await tx.query(
      `insert into deedbox.party_name (party, name_kind, full_name, given_names, family_name, org_name)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        input.party,
        input.nameKind,
        fullName,
        input.givenNames ?? null,
        input.familyName ?? null,
        input.orgName ?? null,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'party',
      subject: input.party,
      detail: { added_name: { kind: input.nameKind, full_name: fullName } },
    })
  })
}
