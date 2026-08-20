// Search, recents, pins, and the position cache — the one sanctioned cache.
// Search rides the synchronous index — money values are absent from index
// bodies by construction — combined with the viewer's predicate compiled
// into the query: a restricted matter can never appear, even as a
// suggestion. The position cache is a derived row: recomputes carry no
// register entries, no figure of record ever reads it, and the verifier
// corrects divergence in place while reporting it as a release-grade defect
// signal.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'

export interface SearchHit {
  entryType: string
  source: number
  matter: number | null
  title: string
  snippet: string
}

/**
 * The predicate bound into every search query: an index row is visible when
 * it carries no matter (party rows), or its matter passes the viewer's row
 * security (the join filters it), and personal rows only for their owner.
 */
const VISIBLE_INDEX = `
  from deedbox.search_index si
  left join deedbox.matter m on m.id = si.matter
  where (si.matter is null or m.id is not null)
    and (si.owner_staff is null or si.owner_staff = $1)
`

/** Suggest as-you-type: top ten, grouped by type. */
export async function suggest(
  p: Principal,
  input: { query: string },
): Promise<{ hits: SearchHit[] }> {
  requireStaff(p)
  const q = input.query.trim()
  if (q.length < 2) throw new OperationRefused('too_short', 'suggestions start at two characters')
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select si.entry_type, si.source, si.matter, si.display_title,
                left(si.body, 120) as snippet
           ${VISIBLE_INDEX}
             and (si.display_title ilike '%' || $2 || '%'
                  or si.body ilike '%' || $2 || '%')
           order by si.entry_type, si.updated_at desc
           limit 10`,
        [p.id, q],
      )
      return {
        hits: r.rows.map((x) => ({
          entryType: x.entry_type as string,
          source: x.source as number,
          matter: x.matter as number | null,
          title: x.display_title as string,
          snippet: x.snippet as string,
        })),
      }
    },
    { readOnly: true },
  )
}

/** Full search, paginated, filterable by type. */
export async function search(
  p: Principal,
  input: { query: string; entryType?: string; limit?: number; offset?: number },
): Promise<{ hits: SearchHit[] }> {
  requireStaff(p)
  const q = input.query.trim()
  if (q.length < 2) throw new OperationRefused('too_short', 'search starts at two characters')
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select si.entry_type, si.source, si.matter, si.display_title,
                left(si.body, 240) as snippet
           ${VISIBLE_INDEX}
             and ($3::text is null or si.entry_type = $3)
             and (si.display_title ilike '%' || $2 || '%'
                  or si.body ilike '%' || $2 || '%')
           order by si.updated_at desc
           limit $4::int offset $5::int`,
        [p.id, q, input.entryType ?? null, Math.min(input.limit ?? 50, 200), input.offset ?? 0],
      )
      return {
        hits: r.rows.map((x) => ({
          entryType: x.entry_type as string,
          source: x.source as number,
          matter: x.matter as number | null,
          title: x.display_title as string,
          snippet: x.snippet as string,
        })),
      }
    },
    { readOnly: true },
  )
}

/** Record a view (upsert, trimmed to fifty; not registered). */
export async function recordView(
  p: Principal,
  input: { itemType: 'matter' | 'party'; item: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await tx.query(
      `insert into deedbox.recent_item (staff, item_type, item)
       values ($1, $2, $3)
       on conflict (staff, item_type, item) do update set last_viewed_at = now()`,
      [p.id, input.itemType, input.item],
    )
    await tx.query(
      `delete from deedbox.recent_item
        where staff = $1 and id not in (
          select id from deedbox.recent_item where staff = $1
          order by last_viewed_at desc limit 50)`,
      [p.id],
    )
  })
}

/** Pin / unpin / reorder (cap 20, schema-enforced; not registered). */
export async function pinItem(
  p: Principal,
  input: { itemType: 'matter' | 'party'; item: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const next = await tx.query(
      `select coalesce(max(position), 0) + 1 as pos from deedbox.pinned_item where staff = $1`,
      [p.id],
    )
    await tx.query(
      `insert into deedbox.pinned_item (staff, item_type, item, position)
       values ($1, $2, $3, $4)
       on conflict (staff, item_type, item) do nothing`,
      [p.id, input.itemType, input.item, next.rows[0].pos],
    )
  })
}

export async function unpinItem(
  p: Principal,
  input: { itemType: 'matter' | 'party'; item: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await tx.query(
      `delete from deedbox.pinned_item where staff = $1 and item_type = $2 and item = $3`,
      [p.id, input.itemType, input.item],
    )
  })
}

/** Recompute stale cache rows past the register frontier. */
export async function recomputePositionCache(
  p: Principal,
  input?: { fullRebuild?: boolean },
): Promise<{ recomputed: number }> {
  return withPrincipal(p, async (tx) => {
    const frontier = await tx.query(`select coalesce(max(id), 0) as seq from deedbox.register_entry`)
    const seq = Number(frontier.rows[0].seq)
    const stale = await tx.query(
      input?.fullRebuild
        ? `select m.id from deedbox.matter m order by m.id`
        : `select m.id from deedbox.matter m
            left join deedbox.matter_position_cache c on c.matter = m.id
           where c.matter is null
              or exists (select 1 from deedbox.register_entry re
                          where re.matter = m.id and re.id > c.as_at_register_seq)
           order by m.id`,
    )
    let recomputed = 0
    for (const row of stale.rows) {
      await tx.query(
        `insert into deedbox.matter_position_cache
           (matter, unbilled_value, outstanding_value, held_available, as_at_register_seq)
         select $1,
           coalesce((select sum(te.value) from deedbox.time_entry te
                      where te.matter = $1 and te.billed_state = 'unbilled' and te.deleted_at is null), 0)
         + coalesce((select sum(d.amount) from deedbox.disbursement d
                      where d.matter = $1 and d.billed_state = 'unbilled' and d.billable and d.deleted_at is null), 0),
           coalesce((select sum(deedbox.bill_outstanding(b.id)) from deedbox.bill b
                      where b.matter = $1 and b.state = 'issued'), 0),
           coalesce((select sum(deedbox.ledger_available(ml.id)) from deedbox.matter_ledger ml
                      where ml.matter = $1 and ml.ledger_kind = 'client_matter' and ml.status = 'open'), 0),
           $2::bigint
         on conflict (matter) do update
           set unbilled_value = excluded.unbilled_value,
               outstanding_value = excluded.outstanding_value,
               held_available = excluded.held_available,
               as_at_register_seq = excluded.as_at_register_seq`,
        [row.id, seq],
      )
      recomputed += 1
    }
    return { recomputed }
  })
}

/** Verify a sample; divergence corrects in place and is reported. */
export async function verifyPositionCache(
  p: Principal,
  input?: { sample?: number },
): Promise<{ checked: number; diverged: number[] }> {
  return withPrincipal(p, async (tx) => {
    const rows = await tx.query(
      `select c.matter, c.unbilled_value, c.outstanding_value, c.held_available
         from deedbox.matter_position_cache c
        order by c.as_at_register_seq limit $1::int`,
      [input?.sample ?? 20],
    )
    const diverged: number[] = []
    for (const c of rows.rows) {
      const fresh = await tx.query(
        `select
           coalesce((select sum(te.value) from deedbox.time_entry te
                      where te.matter = $1 and te.billed_state = 'unbilled' and te.deleted_at is null), 0)
         + coalesce((select sum(d.amount) from deedbox.disbursement d
                      where d.matter = $1 and d.billed_state = 'unbilled' and d.billable and d.deleted_at is null), 0) as unbilled,
           coalesce((select sum(deedbox.bill_outstanding(b.id)) from deedbox.bill b
                      where b.matter = $1 and b.state = 'issued'), 0) as outstanding,
           coalesce((select sum(deedbox.ledger_available(ml.id)) from deedbox.matter_ledger ml
                      where ml.matter = $1 and ml.ledger_kind = 'client_matter' and ml.status = 'open'), 0) as held`,
        [c.matter],
      )
      const f = fresh.rows[0]
      const same =
        Math.round(Number(c.unbilled_value) * 100) === Math.round(Number(f.unbilled) * 100) &&
        Math.round(Number(c.outstanding_value) * 100) === Math.round(Number(f.outstanding) * 100) &&
        Math.round(Number(c.held_available) * 100) === Math.round(Number(f.held) * 100)
      if (!same) {
        diverged.push(c.matter as number)
        await tx.query(
          `update deedbox.matter_position_cache
              set unbilled_value = $2, outstanding_value = $3, held_available = $4
            where matter = $1`,
          [c.matter, f.unbilled, f.outstanding, f.held],
        )
      }
    }
    return { checked: rows.rowCount!, diverged }
  })
}

/**
 * The search-index rebuild job: re-derives every entry from its
 * source table with the feeders' exact projections (0016, test containment
 * per 0022) and removes rows whose source is gone or ineligible. A second
 * run changes nothing — the rebuild is a fixpoint.
 */
export async function rebuildSearchIndex(
  p: Principal,
): Promise<{ upserted: number; removed: number }> {
  return withPrincipal(p, async (tx) => {
    let upserted = 0
    let removed = 0
    const upsert = async (sql: string) => {
      const r = await tx.query(
        `insert into deedbox.search_index (entry_type, source, matter, owner_staff, display_title, body)
         ${sql}
         on conflict (entry_type, source) do update
           set matter = excluded.matter, owner_staff = excluded.owner_staff,
               display_title = excluded.display_title, body = excluded.body,
               updated_at = now()
         returning xmax = 0 as inserted`,
      )
      upserted += r.rowCount ?? 0
    }
    const remove = async (sql: string) => {
      const r = await tx.query(`delete from deedbox.search_index si ${sql}`)
      removed += r.rowCount ?? 0
    }

    await upsert(
      `select 'matter', m.id, m.id, null::bigint, m.matter_number || ' ' || m.title, coalesce(m.summary,'') from deedbox.matter m`,
    )
    await upsert(
      `select 'party', pn.id, null::bigint, null::bigint, pn.full_name, ''
         from deedbox.party_name pn join deedbox.party p on p.id = pn.party where not p.test`,
    )
    await remove(
      `where si.entry_type = 'party' and not exists (
         select 1 from deedbox.party_name pn join deedbox.party p on p.id = pn.party
          where pn.id = si.source and not p.test)`,
    )
    await upsert(
      `select 'note', n.id, case when n.owner_type = 'matter' then n.owner end, null::bigint,
              left(n.body, 80), n.body
         from deedbox.note n where n.deleted_at is null`,
    )
    await remove(
      `where si.entry_type = 'note' and not exists (
         select 1 from deedbox.note n where n.id = si.source and n.deleted_at is null)`,
    )
    await upsert(
      `select 'task', t.id, t.matter, case when t.matter is null then t.owner end, t.title, ''
         from deedbox.task t where t.deleted_at is null`,
    )
    await remove(
      `where si.entry_type = 'task' and not exists (
         select 1 from deedbox.task t where t.id = si.source and t.deleted_at is null)`,
    )
    await upsert(
      `select 'key_date', k.id, k.matter, null::bigint, k.title, ''
         from deedbox.key_date k where k.deleted_at is null`,
    )
    await remove(
      `where si.entry_type = 'key_date' and not exists (
         select 1 from deedbox.key_date k where k.id = si.source and k.deleted_at is null)`,
    )
    await upsert(
      `select 'time_entry', te.id, te.matter, null::bigint, left(te.narrative, 80), te.narrative
         from deedbox.time_entry te where te.deleted_at is null`,
    )
    await remove(
      `where si.entry_type = 'time_entry' and not exists (
         select 1 from deedbox.time_entry te where te.id = si.source and te.deleted_at is null)`,
    )
    await upsert(
      `select 'custom_field_value', v.id, case when v.owner_type = 'matter' then v.owner end, null::bigint,
              left(v.text_value, 80), v.text_value
         from deedbox.custom_field_value v
        where v.text_value is not null
          and not (v.owner_type = 'intake_record' and exists (
                select 1 from deedbox.intake_record i where i.id = v.owner and i.test_flag))`,
    )
    await remove(
      `where si.entry_type = 'custom_field_value' and not exists (
         select 1 from deedbox.custom_field_value v
          where v.id = si.source and v.text_value is not null
            and not (v.owner_type = 'intake_record' and exists (
                  select 1 from deedbox.intake_record i where i.id = v.owner and i.test_flag)))`,
    )
    // documents: title as display, the current version's extracted text as body
    await upsert(
      `select 'document', d.id, d.matter, null::bigint, d.title, coalesce(t.content, '')
         from deedbox.document d
         left join deedbox.document_version v
           on v.document = d.id and v.version_no = d.current_version
         left join deedbox.document_version_text t on t.version = v.id
        where d.soft_deleted_at is null`,
    )
    await remove(
      `where si.entry_type = 'document' and not exists (
         select 1 from deedbox.document d where d.id = si.source and d.soft_deleted_at is null)`,
    )
    return { upserted, removed }
  })
}
