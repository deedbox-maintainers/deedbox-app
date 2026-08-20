// Matter relations — relate matters, unrelate, and create-related-matter. The
// schema guard canonicalises the pair (lower id first), refuses
// self-relations, and evaluates the relatable check — honouring
// matter.relations_absent_means_allowed for absent pairs. Both matters'
// timelines carry the act: two register entries share a correlation.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { createMatterInTx, type CreateMatterInput } from './createMatter'

async function emitOnBoth(
  tx: Tx,
  p: Principal,
  kind: string,
  relationId: number,
  matters: [number, number],
  detail: Record<string, unknown>,
): Promise<void> {
  const correlation = `relation-${relationId}`
  for (const m of matters) {
    await emitRegister(tx, p, {
      kind,
      subjectType: 'matter_relation',
      subject: relationId,
      matter: m,
      detail: { ...detail, correlation },
    })
  }
}

export async function relateMatters(
  p: Principal,
  input: { matterA: number; matterB: number; label: number },
): Promise<{ id: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    // both matters must be visible to the actor (row security filters)
    const seen = await tx.query(`select id from deedbox.matter where id = any($1)`, [
      [input.matterA, input.matterB],
    ])
    if (seen.rowCount !== 2) throw new OperationRefused('not_found', 'matter not found')
    const r = await tx.query(
      `insert into deedbox.matter_relation (matter_a, matter_b, label)
       values ($1, $2, $3) returning id, matter_a, matter_b`,
      [input.matterA, input.matterB, input.label],
    )
    const id = r.rows[0].id as number
    await emitOnBoth(tx, p, 'record.created', id, [r.rows[0].matter_a, r.rows[0].matter_b], {
      label: input.label,
    })
    return { id }
  })
}

export async function unrelateMatters(p: Principal, input: { relation: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.matter_relation set deleted_at = now(), deleted_by = $2
        where id = $1 and deleted_at is null
        returning matter_a, matter_b`,
      [input.relation, p.id],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_found', 'relation not found')
    await emitOnBoth(tx, p, 'record.soft_deleted', input.relation, [
      r.rows[0].matter_a,
      r.rows[0].matter_b,
    ], {})
  })
}

export interface CreateRelatedMatterInput
  extends Omit<CreateMatterInput, 'clientParty'> {
  sourceMatter: number
  label: number
  /** Copy the source's live non-client parties into the new matter. */
  copyParties?: boolean
}

/** Create-related-matter: creation and relation in one transaction. */
export async function createRelatedMatter(
  p: Principal,
  input: CreateRelatedMatterInput,
): Promise<{ id: number; matterNumber: string; relation: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const src = await tx.query(
      `select client_party from deedbox.matter where id = $1`,
      [input.sourceMatter],
    )
    if (src.rowCount === 0) throw new OperationRefused('not_found', 'source matter not found')

    const made = await createMatterInTx(
      tx,
      p,
      { ...input, clientParty: src.rows[0].client_party as number },
      {},
    )

    if (input.copyParties) {
      await tx.query(
        `insert into deedbox.matter_party (matter, party, capacity, note)
         select $1, mp.party, mp.capacity, mp.note
           from deedbox.matter_party mp
          where mp.matter = $2 and mp.deleted_at is null
            and not exists (select 1 from deedbox.matter_party e
                             where e.matter = $1 and e.party = mp.party
                               and e.capacity = mp.capacity and e.deleted_at is null)`,
        [made.id, input.sourceMatter],
      )
    }

    const rel = await tx.query(
      `insert into deedbox.matter_relation (matter_a, matter_b, label, carried_parties)
       values ($1, $2, $3, $4) returning id, matter_a, matter_b`,
      [input.sourceMatter, made.id, input.label, input.copyParties ?? false],
    )
    await emitOnBoth(tx, p, 'record.created', rel.rows[0].id as number, [
      rel.rows[0].matter_a,
      rel.rows[0].matter_b,
    ], { label: input.label, carried_parties: input.copyParties ?? false })

    return { id: made.id, matterNumber: made.matterNumber, relation: rel.rows[0].id as number }
  })
}
