// Party merge: dry-run, commit, undo.
//
// The manifest below is THIS domain's published party-bearing-column list
// (matter.client_party, matter_party, intake prospect/party rows, party_link
// both directions). Billing's and money's manifest entries (matter_payer
// share combination, draft-bill payers) land with the billing operations
// slice; the absorbed party row remains behind the merged redirect, so those
// references stay resolvable meanwhile. Immutable snapshots (conflict
// checks, corpus rows, money documents) are untouched by design.
//
// Derived-row principle: client-capacity matter-party rows are MAINTAINED BY
// TRIGGER on every client_party write. The merge therefore never repoints or
// replays them — the client-column update does the maintenance in both
// directions, and a watermark sweep removes the trigger's as-related residue
// rows (recorded as informational items that reverse as no-ops). Everything
// else lands as a bulk item with before/after, so the undo replays exact
// inverses; a row later touched blocks individually, and the merge is marked
// undone only on a clean full reversal.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireCapability, requireStaff, settingText } from '@/lib/ops/shared'

interface MergeItem {
  entityType: string
  entity: number
  before: Record<string, unknown>
  after: Record<string, unknown>
}

export interface MergeDryRun {
  survivor: { id: number; displayName: string }
  absorbed: { id: number; displayName: string; content: Record<string, unknown> }
  repoints: { table: string; rows: number }[]
  collisions: string[]
  restrictedMattersInvolved: number
}

async function partyOrRefuse(tx: Tx, id: number, role: string) {
  const r = await tx.query(
    `select id, kind, display_name, state, portal_login, notes, deleted_at
       from deedbox.party where id = $1`,
    [id],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', `${role} party not found`)
  if (r.rows[0].state !== 'active' || r.rows[0].deleted_at !== null) {
    throw new OperationRefused('party_inactive', `the ${role} must be an active party`)
  }
  return r.rows[0] as {
    id: number
    kind: string
    display_name: string
    state: string
    portal_login: string | null
    notes: string | null
  }
}

/** The read-only dry run. */
export async function dryRunMerge(
  p: Principal,
  input: { survivor: number; absorbed: number },
): Promise<MergeDryRun> {
  requireStaff(p)
  if (input.survivor === input.absorbed) {
    throw new OperationRefused('same_party', 'a party is never merged into itself')
  }
  return withPrincipal(
    p,
    async (tx) => {
      const survivor = await partyOrRefuse(tx, input.survivor, 'survivor')
      const absorbed = await partyOrRefuse(tx, input.absorbed, 'absorbed')

      // Closed/archived matters and converted intakes are terminal records:
      // their pointers stay put and resolve through the merged-party
      // redirect (immutable history is untouched).
      const counts = await tx.query(
        `select
           (select count(*) from deedbox.matter where client_party = $1
             and status in ('open','on_hold'))::int as client_col,
           (select count(*) from deedbox.matter where client_party = $1
             and status in ('closed','archived'))::int as client_col_terminal,
           (select count(*) from deedbox.matter_party where party = $1 and deleted_at is null)::int as matter_parties,
           (select count(*) from deedbox.intake_record where prospect_party = $1
             and deleted_at is null and state <> 'converted')::int as prospects,
           (select count(*) from deedbox.intake_party where party = $1 and deleted_at is null)::int as intake_parties,
           (select count(*) from deedbox.party_link where (from_party = $1 or to_party = $1) and deleted_at is null)::int as links`,
        [input.absorbed],
      )
      const c = counts.rows[0]

      const collisions: string[] = []
      const mpCollide = await tx.query(
        `select count(*)::int as n from deedbox.matter_party a
          where a.party = $1 and a.deleted_at is null
            and exists (select 1 from deedbox.matter_party b
                         where b.matter = a.matter and b.capacity = a.capacity
                           and b.party = $2 and b.deleted_at is null)`,
        [input.absorbed, input.survivor],
      )
      if (mpCollide.rows[0].n > 0) {
        collisions.push(
          `${mpCollide.rows[0].n} matter-party row(s) where both parties already hold the same capacity — the duplicate deactivates`,
        )
      }
      const linkCollide = await tx.query(
        `select count(*)::int as n from deedbox.party_link l
          where l.deleted_at is null
            and ((l.from_party = $1 and l.to_party = $2) or (l.from_party = $2 and l.to_party = $1))`,
        [input.absorbed, input.survivor],
      )
      if (linkCollide.rows[0].n > 0) {
        collisions.push(
          `${linkCollide.rows[0].n} link(s) between the two parties — a self-link cannot stand and deactivates`,
        )
      }

      // matters involved that the caller cannot see: side-table ids minus
      // the predicate-visible set (shown only as a count)
      const involved = await tx.query(
        `select array_agg(distinct m) as ids from (
           select mp.matter as m from deedbox.matter_party mp where mp.party = $1 and mp.deleted_at is null
           union select mt.id from deedbox.matter mt where mt.client_party = $1
         ) x`,
        [input.absorbed],
      )
      const ids: number[] = involved.rows[0].ids ?? []
      let restricted = 0
      if (ids.length > 0) {
        const visible = await tx.query(`select count(*)::int as n from deedbox.matter where id = any($1)`, [ids])
        restricted = ids.length - (visible.rows[0].n as number)
      }

      const names = await tx.query(
        `select name_kind, full_name from deedbox.party_name where party = $1 order by id`,
        [input.absorbed],
      )
      const contacts = await tx.query(
        `select kind, value, is_primary from deedbox.contact_point
          where party = $1 and deleted_at is null order by id`,
        [input.absorbed],
      )

      return {
        survivor: { id: survivor.id, displayName: survivor.display_name },
        absorbed: {
          id: absorbed.id,
          displayName: absorbed.display_name,
          content: { names: names.rows, contacts: contacts.rows, notes: absorbed.notes },
        },
        repoints: [
          { table: 'matter (client column)', rows: c.client_col },
          { table: 'matter (client column, terminal — resolves via redirect)', rows: c.client_col_terminal },
          { table: 'matter parties', rows: c.matter_parties },
          { table: 'intake prospects', rows: c.prospects },
          { table: 'intake parties', rows: c.intake_parties },
          { table: 'party links', rows: c.links },
        ],
        collisions,
        restrictedMattersInvolved: restricted,
      }
    },
    { readOnly: true },
  )
}

/** Commit. The dry-run summary is stored verbatim on the run. */
export async function commitMerge(
  p: Principal,
  input: { survivor: number; absorbed: number; dryRun: MergeDryRun },
): Promise<{ merge: number; bulkOperation: number }> {
  if (input.survivor === input.absorbed) {
    throw new OperationRefused('same_party', 'a party is never merged into itself')
  }
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'merge.execute')

    // lock both party rows in ascending order
    const first = Math.min(input.survivor, input.absorbed)
    const second = Math.max(input.survivor, input.absorbed)
    await tx.query(`select id from deedbox.party where id = $1 for update`, [first])
    await tx.query(`select id from deedbox.party where id = $1 for update`, [second])
    const survivor = await partyOrRefuse(tx, input.survivor, 'survivor')
    const absorbed = await partyOrRefuse(tx, input.absorbed, 'absorbed')

    const windowDays = Number((await settingText(tx, 'undo.bulk_window_days')) ?? '7')
    const op = await tx.query(
      `insert into deedbox.bulk_operation
         (operation_kind, dry_run_summary, committed_at, committed_by, reversible_until)
       values ('party_merge', $1, now(), $2, now() + make_interval(days => $3))
       returning id`,
      [JSON.stringify(input.dryRun), p.id, windowDays],
    )
    const opId = op.rows[0].id as number
    const items: MergeItem[] = []
    const repointedLinks: Record<string, unknown>[] = []

    const watermark = await tx.query(
      `select coalesce(max(id), 0) as w from deedbox.matter_party`,
    )
    const preMergeMaxRow = watermark.rows[0].w as number
    const clientCap = await tx.query(`select deedbox.client_capacity_item() as c`)
    const clientCapId = clientCap.rows[0].c as number

    // 1. matter_party rows EXCEPT client-capacity ones (those are derived —
    //    the client-column update's trigger maintains them): collisions
    //    deactivate, the rest repoint.
    const mpRows = await tx.query(
      `select id, matter, capacity from deedbox.matter_party
        where party = $1 and deleted_at is null and capacity <> $2
        order by id for update`,
      [input.absorbed, clientCapId],
    )
    for (const row of mpRows.rows) {
      const dup = await tx.query(
        `select 1 from deedbox.matter_party
          where matter = $1 and capacity = $2 and party = $3 and deleted_at is null`,
        [row.matter, row.capacity, input.survivor],
      )
      if (dup.rowCount! > 0) {
        await tx.query(
          `update deedbox.matter_party set deleted_at = now(), deleted_by = $2 where id = $1`,
          [row.id, p.id],
        )
        items.push({
          entityType: 'matter_party.deactivated_duplicate',
          entity: row.id as number,
          before: { party: input.absorbed, deleted: false },
          after: { party: input.absorbed, deleted: true },
        })
        repointedLinks.push({ table: 'matter_party', row: row.id, outcome: 'duplicate_deactivated' })
      } else {
        await tx.query(`update deedbox.matter_party set party = $2 where id = $1`, [
          row.id,
          input.survivor,
        ])
        items.push({
          entityType: 'matter_party.party',
          entity: row.id as number,
          before: { party: input.absorbed },
          after: { party: input.survivor },
        })
        repointedLinks.push({ table: 'matter_party', row: row.id, outcome: 'repointed' })
      }
    }

    // 2. the client column on LIVE matters only; terminal matters keep their
    //    pointer and resolve via the redirect. The trigger deletes the
    //    absorbed party's client row, installs the survivor's, and creates
    //    one absorbed-as-related residue row per matter — swept below by
    //    watermark and recorded as informational no-reversal items.
    const clientMatters = await tx.query(
      `select id from deedbox.matter
        where client_party = $1 and status in ('open','on_hold')
        order by id for update`,
      [input.absorbed],
    )
    for (const row of clientMatters.rows) {
      await tx.query(`update deedbox.matter set client_party = $2 where id = $1`, [
        row.id,
        input.survivor,
      ])
      items.push({
        entityType: 'matter.client_party',
        entity: row.id as number,
        before: { client_party: input.absorbed },
        after: { client_party: input.survivor },
      })
      repointedLinks.push({ table: 'matter.client_party', row: row.id, outcome: 'repointed' })
    }
    const strays = await tx.query(
      `update deedbox.matter_party set deleted_at = now(), deleted_by = $2
        where party = $1 and deleted_at is null and id > $3
        returning id`,
      [input.absorbed, p.id, preMergeMaxRow],
    )
    for (const s of strays.rows) {
      items.push({
        entityType: 'matter_party.trigger_residue_swept',
        entity: s.id as number,
        before: { created_by_merge: true },
        after: { swept: true },
      })
    }

    // 3. intake rows (converted records are terminal; the redirect covers them).
    const prospects = await tx.query(
      `update deedbox.intake_record set prospect_party = $2
        where prospect_party = $1 and deleted_at is null and state <> 'converted'
        returning id`,
      [input.absorbed, input.survivor],
    )
    for (const r of prospects.rows) {
      items.push({
        entityType: 'intake_record.prospect_party',
        entity: r.id as number,
        before: { prospect_party: input.absorbed },
        after: { prospect_party: input.survivor },
      })
    }
    const ipRows = await tx.query(
      `select id, intake, capacity from deedbox.intake_party
        where party = $1 and deleted_at is null order by id for update`,
      [input.absorbed],
    )
    for (const row of ipRows.rows) {
      const dup = await tx.query(
        `select 1 from deedbox.intake_party
          where intake = $1 and capacity = $2 and party = $3 and deleted_at is null`,
        [row.intake, row.capacity, input.survivor],
      )
      if (dup.rowCount! > 0) {
        await tx.query(
          `update deedbox.intake_party set deleted_at = now(), deleted_by = $2 where id = $1`,
          [row.id, p.id],
        )
        items.push({
          entityType: 'intake_party.deactivated_duplicate',
          entity: row.id as number,
          before: { party: input.absorbed, deleted: false },
          after: { party: input.absorbed, deleted: true },
        })
      } else {
        await tx.query(`update deedbox.intake_party set party = $2 where id = $1`, [
          row.id,
          input.survivor,
        ])
        items.push({
          entityType: 'intake_party.party',
          entity: row.id as number,
          before: { party: input.absorbed },
          after: { party: input.survivor },
        })
      }
    }

    // 4. links, both directions; self-links and duplicates deactivate.
    const links = await tx.query(
      `select id, from_party, to_party, link_kind from deedbox.party_link
        where (from_party = $1 or to_party = $1) and deleted_at is null
        order by id for update`,
      [input.absorbed],
    )
    for (const l of links.rows) {
      const newFrom = l.from_party === input.absorbed ? input.survivor : (l.from_party as number)
      const newTo = l.to_party === input.absorbed ? input.survivor : (l.to_party as number)
      const dup =
        newFrom === newTo
          ? { rowCount: 1 }
          : await tx.query(
              `select 1 from deedbox.party_link
                where from_party = $1 and to_party = $2 and link_kind = $3
                  and deleted_at is null and id <> $4`,
              [newFrom, newTo, l.link_kind, l.id],
            )
      if (dup.rowCount! > 0) {
        await tx.query(
          `update deedbox.party_link set deleted_at = now(), deleted_by = $2 where id = $1`,
          [l.id, p.id],
        )
        items.push({
          entityType: 'party_link.deactivated',
          entity: l.id as number,
          before: { from_party: l.from_party, to_party: l.to_party, deleted: false },
          after: { from_party: l.from_party, to_party: l.to_party, deleted: true },
        })
      } else {
        await tx.query(`update deedbox.party_link set from_party = $2, to_party = $3 where id = $1`, [
          l.id,
          newFrom,
          newTo,
        ])
        items.push({
          entityType: 'party_link.repointed',
          entity: l.id as number,
          before: { from_party: l.from_party, to_party: l.to_party },
          after: { from_party: newFrom, to_party: newTo },
        })
      }
    }

    // 5. the absorbed record: snapshot, freeze behind the redirect, portal off.
    const names = await tx.query(
      `select name_kind, full_name, given_names, family_name, org_name
         from deedbox.party_name where party = $1 order by id`,
      [input.absorbed],
    )
    const contacts = await tx.query(
      `select kind, value, label, is_primary from deedbox.contact_point
        where party = $1 and deleted_at is null order by id`,
      [input.absorbed],
    )
    const addresses = await tx.query(
      `select kind, lines, locality, region, postcode, country from deedbox.postal_address
        where party = $1 and deleted_at is null order by id`,
      [input.absorbed],
    )
    const absorbedSnapshot = {
      party: absorbed,
      names: names.rows,
      contacts: contacts.rows,
      addresses: addresses.rows,
      portal_login_disabled: absorbed.portal_login,
    }
    await tx.query(
      `update deedbox.party set state = 'merged', merged_into = $2, portal_login = null
        where id = $1`,
      [input.absorbed, input.survivor],
    )
    items.push({
      entityType: 'party.merged',
      entity: input.absorbed,
      before: { state: 'active', merged_into: null, portal_login: absorbed.portal_login },
      after: { state: 'merged', merged_into: input.survivor, portal_login: null },
    })

    // 6. the record layer + the privileged register event.
    for (const it of items) {
      await tx.query(
        `insert into deedbox.bulk_operation_item (operation, entity_type, entity, before, after)
         values ($1, $2, $3, $4, $5)`,
        [opId, it.entityType, it.entity, JSON.stringify(it.before), JSON.stringify(it.after)],
      )
    }
    const merge = await tx.query(
      `insert into deedbox.party_merge
         (survivor, absorbed, absorbed_snapshot, repointed_links, performed_by, bulk_operation)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        input.survivor,
        input.absorbed,
        JSON.stringify(absorbedSnapshot),
        JSON.stringify(repointedLinks),
        p.id,
        opId,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'merge.executed',
      subjectType: 'party_merge',
      subject: merge.rows[0].id as number,
      privileged: true,
      detail: {
        before: { survivor: input.survivor, absorbed: absorbedSnapshot },
        after: { survivor: input.survivor, absorbed_state: 'merged', items: items.length },
      },
    })
    return { merge: merge.rows[0].id as number, bulkOperation: opId }
  })
}

/** Undo — replay inverses newest-first; touched rows block individually. */
export async function undoMerge(
  p: Principal,
  input: { merge: number; reason: string },
): Promise<{ reversed: number; blocked: number; undone: boolean }> {
  if (!input.reason || !input.reason.trim()) {
    throw new OperationRefused('reason_required', 'a bulk reversal always carries a reason')
  }
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'merge.execute')
    const merge = await tx.query(
      `select m.id, m.survivor, m.absorbed, m.undone_at, m.bulk_operation,
              o.reversible_until, o.reversed_at
         from deedbox.party_merge m
         join deedbox.bulk_operation o on o.id = m.bulk_operation
        where m.id = $1 for update of m`,
      [input.merge],
    )
    if (merge.rowCount === 0) throw new OperationRefused('not_found', 'merge not found')
    const mg = merge.rows[0]
    if (mg.undone_at !== null) throw new OperationRefused('already_undone', 'this merge is already undone')
    if (mg.reversed_at !== null) {
      throw new OperationRefused('already_reversed', 'this run has already had its reversal')
    }
    const windowOpen = await tx.query(`select $1::timestamptz >= now() as open`, [mg.reversible_until])
    if (!windowOpen.rows[0].open) {
      throw new OperationRefused('window_closed', 'the undo window for this merge has closed')
    }

    const itemRows = await tx.query(
      `select id, entity_type, entity, before, after from deedbox.bulk_operation_item
        where operation = $1 and reversal_outcome is null order by id desc`,
      [mg.bulk_operation],
    )
    const watermark = await tx.query(`select coalesce(max(id), 0) as w from deedbox.matter_party`)
    const preUndoMaxRow = watermark.rows[0].w as number
    let reversed = 0
    let blocked = 0
    for (const it of itemRows.rows) {
      const outcome = await reverseItem(tx, it)
      if (outcome === null) {
        await tx.query(
          `update deedbox.bulk_operation_item set reversal_outcome = 'reversed' where id = $1`,
          [it.id],
        )
        reversed++
      } else {
        await tx.query(
          `update deedbox.bulk_operation_item
              set reversal_outcome = 'blocked', block_reason = $2 where id = $1`,
          [it.id, outcome],
        )
        blocked++
      }
    }
    // The client-column reversals just re-fired the maintenance trigger,
    // which parked the survivor as a related party on each reversed matter —
    // residue of the undo itself, swept by the same watermark discipline.
    await tx.query(
      `update deedbox.matter_party set deleted_at = now(), deleted_by = $2
        where party = $3 and deleted_at is null and id > $1
          and capacity in (select ci.id from deedbox.choice_item ci
                             join deedbox.choice_list cl on cl.id = ci.list
                            where cl.purpose_key = 'matter_party_capacities'
                              and ci.shipped_key = 'related_party')`,
      [preUndoMaxRow, p.id, mg.survivor],
    )

    const undone = blocked === 0
    if (undone) {
      await tx.query(`update deedbox.party_merge set undone_at = now() where id = $1`, [input.merge])
    }
    await tx.query(
      `update deedbox.bulk_operation set reversed_at = now(), reversed_by = $2 where id = $1`,
      [mg.bulk_operation, p.id],
    )
    await emitRegister(tx, p, {
      kind: 'bulk.reversed',
      subjectType: 'bulk_operation',
      subject: mg.bulk_operation as number,
      reason: input.reason,
      detail: { merge: input.merge, reversed, blocked, undone },
    })
    return { reversed, blocked, undone }
  })
}

/** Returns null on success, or the block reason. */
async function reverseItem(
  tx: Tx,
  it: { entity_type: string; entity: number; before: Record<string, unknown>; after: Record<string, unknown> },
): Promise<string | null> {
  const t = it.entity_type
  if (t === 'party.merged') {
    const cur = await tx.query(`select state, merged_into from deedbox.party where id = $1`, [it.entity])
    if (cur.rowCount === 0 || cur.rows[0].state !== 'merged') return 'party no longer in merged state'
    await tx.query(
      `update deedbox.party set state = 'active', merged_into = null, portal_login = $2 where id = $1`,
      [it.entity, (it.before.portal_login as string | null) ?? null],
    )
    return null
  }
  if (t === 'matter.client_party') {
    const cur = await tx.query(`select client_party, status from deedbox.matter where id = $1`, [it.entity])
    if (cur.rowCount === 0) return 'matter not visible to the reverser'
    if (cur.rows[0].client_party !== it.after.client_party) return 'client changed since the merge'
    if (cur.rows[0].status !== 'open' && cur.rows[0].status !== 'on_hold') {
      return `matter is ${cur.rows[0].status}; the client changes only on open or on-hold matters`
    }
    await tx.query(`update deedbox.matter set client_party = $2 where id = $1`, [
      it.entity,
      it.before.client_party,
    ])
    return null
  }
  if (t === 'matter_party.party' || t === 'intake_party.party') {
    const table = t.startsWith('matter') ? 'matter_party' : 'intake_party'
    const cur = await tx.query(
      `select party, deleted_at from deedbox.${table} where id = $1`,
      [it.entity],
    )
    if (cur.rowCount === 0) return 'row gone'
    if (cur.rows[0].deleted_at !== null || cur.rows[0].party !== it.after.party) {
      return 'row touched since the merge'
    }
    await tx.query(`update deedbox.${table} set party = $2 where id = $1`, [it.entity, it.before.party])
    return null
  }
  if (t === 'matter_party.trigger_residue_swept') {
    // the row was created and swept within the merge; its pre-merge state
    // is nonexistence — staying swept IS the inverse
    return null
  }
  if (
    t === 'matter_party.deactivated_duplicate' ||
    t === 'intake_party.deactivated_duplicate'
  ) {
    const table = t.startsWith('matter') ? 'matter_party' : 'intake_party'
    const cur = await tx.query(`select deleted_at from deedbox.${table} where id = $1`, [it.entity])
    if (cur.rowCount === 0) return 'row gone'
    if (cur.rows[0].deleted_at === null) return 'row already restored'
    await tx.query(`update deedbox.${table} set deleted_at = null, deleted_by = null where id = $1`, [
      it.entity,
    ])
    return null
  }
  if (t === 'party_link.repointed') {
    const cur = await tx.query(
      `select from_party, to_party, deleted_at from deedbox.party_link where id = $1`,
      [it.entity],
    )
    if (cur.rowCount === 0) return 'row gone'
    if (
      cur.rows[0].deleted_at !== null ||
      cur.rows[0].from_party !== it.after.from_party ||
      cur.rows[0].to_party !== it.after.to_party
    ) {
      return 'link touched since the merge'
    }
    await tx.query(`update deedbox.party_link set from_party = $2, to_party = $3 where id = $1`, [
      it.entity,
      it.before.from_party,
      it.before.to_party,
    ])
    return null
  }
  if (t === 'party_link.deactivated') {
    const cur = await tx.query(`select deleted_at from deedbox.party_link where id = $1`, [it.entity])
    if (cur.rowCount === 0) return 'row gone'
    if (cur.rows[0].deleted_at === null) return 'link already restored'
    await tx.query(`update deedbox.party_link set deleted_at = null, deleted_by = null where id = $1`, [
      it.entity,
    ])
    return null
  }
  if (t === 'intake_record.prospect_party') {
    const cur = await tx.query(
      `select prospect_party, state from deedbox.intake_record where id = $1`,
      [it.entity],
    )
    if (cur.rowCount === 0) return 'row gone'
    if (cur.rows[0].prospect_party !== it.after.prospect_party) return 'prospect changed since the merge'
    if (cur.rows[0].state === 'converted') return 'intake converted since the merge'
    await tx.query(`update deedbox.intake_record set prospect_party = $2 where id = $1`, [
      it.entity,
      it.before.prospect_party,
    ])
    return null
  }
  return `no reverser for ${t}`
}
