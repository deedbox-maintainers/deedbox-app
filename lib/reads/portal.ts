// Portal reads: every query runs AS the portal principal, so the 0005
// predicate's portal rule does the scoping — a portal client sees exactly
// the matters whose matter_party row switched portal access on, and
// nothing needs a bespoke filter. Money never enters these reads beyond
// the issued-bill figures the portal shows.

import type { Principal } from '@/lib/db'
import { withPrincipal } from '@/lib/db'
import { firmRegional } from '@/lib/ops/shared'

export async function portalHome(p: Principal): Promise<{
  partyName: string
  matters: { id: number; matterNumber: string; title: string; status: string }[]
}> {
  return withPrincipal(
    p,
    async (tx) => {
      const name = await tx.query(
        `select full_name from deedbox.party_name where party = $1 and name_kind = 'current' limit 1`,
        [p.id],
      )
      const matters = await tx.query(
        `select id, matter_number, title, status from deedbox.matter order by id desc`,
      )
      return {
        partyName: (name.rows[0]?.full_name as string | undefined) ?? 'Client',
        matters: matters.rows.map((m) => ({
          id: m.id as number,
          matterNumber: m.matter_number as string,
          title: m.title as string,
          status: m.status as string,
        })),
      }
    },
    { readOnly: true },
  )
}

export async function portalMatter(
  p: Principal,
  matterId: number,
): Promise<{
  matter: { id: number; matterNumber: string; title: string; status: string; openedDate: string }
  responsible: string
  bills: { id: number; billNumber: string; issueDate: string; total: number; outstanding: number }[]
  regional: { currency: string; locale: string }
}> {
  return withPrincipal(
    p,
    async (tx) => {
      const m = await tx.query(
        `select m.id, m.matter_number, m.title, m.status, m.opened_date,
                (s.person_name->>'given') || ' ' || (s.person_name->>'family') as responsible
           from deedbox.matter m
           join deedbox.staff_member s on s.id = m.responsible_lawyer
          where m.id = $1`,
        [matterId],
      )
      if (m.rowCount === 0) throw new Error('not_found')
      const bills = await tx.query(
        `select b.id, b.bill_number, b.issue_date,
                coalesce((select sum(j.signed_amount) from deedbox.bill_journal_entry j
                           where j.bill = b.id and j.entry_kind in ('issue_total','interest_charge')), 0) as total,
                deedbox.bill_outstanding(b.id) as outstanding
           from deedbox.bill b
           join deedbox.matter m on m.id = b.matter
          where b.matter = $1 and b.state = 'issued'
          order by b.issue_date desc`,
        [matterId],
      )
      return {
        matter: {
          id: m.rows[0].id as number,
          matterNumber: m.rows[0].matter_number as string,
          title: m.rows[0].title as string,
          status: m.rows[0].status as string,
          openedDate: String(m.rows[0].opened_date),
        },
        responsible: (m.rows[0].responsible as string | null) ?? '',
        bills: bills.rows.map((b) => ({
          id: b.id as number,
          billNumber: b.bill_number as string,
          issueDate: String(b.issue_date),
          total: Number(b.total),
          outstanding: Number(b.outstanding),
        })),
        regional: await firmRegional(tx, p.firm),
      }
    },
    { readOnly: true },
  )
}

/** The staff panel's invite list for one party (predicate via the party read path). */
export async function partyPortalInvites(
  p: Principal,
  partyId: number,
): Promise<
  {
    id: number
    email: string
    expiresAt: string
    acceptedAt: string | null
    lastLoginAt: string | null
    revoked: boolean
  }[]
> {
  const { listPortalInvites } = await import('@/lib/ops/portal')
  return withPrincipal(
    p,
    async (tx) => listPortalInvites(tx, partyId),
    { readOnly: true },
  )
}
