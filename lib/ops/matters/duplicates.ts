// The duplicate check, a read-only service. One rule for every surface that
// can create a party: candidates are active parties where a name key
// fuzzy-matches AND (phone matches OR email matches); with neither phone
// nor email given, exact-normalised-name only. The heavy lifting is the
// schema's duplicate_candidates() (0007).

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal } from '@/lib/db'

export interface DuplicateCandidate {
  party: number
  displayName: string
  names: { kind: string; fullName: string }[]
  phones: string[]
  emails: string[]
  /** Matters shared with the candidate that the CALLER can see. */
  visibleMatters: { id: number; matterNumber: string; title: string }[]
  /** Shared matters the caller cannot see — disclosed as a count only. */
  hiddenMatterCount: number
}

export async function checkDuplicates(
  p: Principal,
  input: { name: string; phone?: string; email?: string },
): Promise<DuplicateCandidate[]> {
  return withPrincipal(
    p,
    async (tx) => {
      const ids = await tx.query(
        `select party from deedbox.duplicate_candidates($1, $2, $3)`,
        [input.name, input.phone ?? null, input.email ?? null],
      )
      const out: DuplicateCandidate[] = []
      for (const row of ids.rows) {
        out.push(await hydrateCandidate(tx, row.party as number))
      }
      return out
    },
    { readOnly: true },
  )
}

/** Same check inside an already-open transaction (create flows re-verify). */
export async function checkDuplicatesInTx(
  tx: Tx,
  input: { name: string; phone?: string; email?: string },
): Promise<number[]> {
  const ids = await tx.query(
    `select party from deedbox.duplicate_candidates($1, $2, $3)`,
    [input.name, input.phone ?? null, input.email ?? null],
  )
  return ids.rows.map((r) => r.party as number)
}

async function hydrateCandidate(tx: Tx, partyId: number): Promise<DuplicateCandidate> {
  const party = await tx.query(
    `select display_name from deedbox.party where id = $1`,
    [partyId],
  )
  const names = await tx.query(
    `select name_kind, full_name from deedbox.party_name where party = $1 order by id`,
    [partyId],
  )
  const contacts = await tx.query(
    `select kind, value from deedbox.contact_point
      where party = $1 and deleted_at is null order by is_primary desc, id`,
    [partyId],
  )
  // Row security on matter filters this join to what the caller may see; the
  // total count over matter_party (no row security) supplies the honest
  // "matters you cannot see" remainder.
  const visible = await tx.query(
    `select distinct m.id, m.matter_number, m.title
       from deedbox.matter_party mp
       join deedbox.matter m on m.id = mp.matter
      where mp.party = $1 and mp.deleted_at is null
      order by m.id`,
    [partyId],
  )
  const total = await tx.query(
    `select count(distinct mp.matter)::int as n
       from deedbox.matter_party mp
      where mp.party = $1 and mp.deleted_at is null`,
    [partyId],
  )
  return {
    party: partyId,
    displayName: party.rows[0].display_name as string,
    names: names.rows.map((n) => ({ kind: n.name_kind as string, fullName: n.full_name as string })),
    phones: contacts.rows.filter((c) => c.kind === 'phone').map((c) => c.value as string),
    emails: contacts.rows.filter((c) => c.kind === 'email').map((c) => c.value as string),
    visibleMatters: visible.rows.map((m) => ({
      id: m.id as number,
      matterNumber: m.matter_number as string,
      title: m.title as string,
    })),
    hiddenMatterCount: (total.rows[0].n as number) - visible.rowCount!,
  }
}
