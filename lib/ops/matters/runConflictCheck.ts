// Run a conflict check.
//
// Two indexes, one snapshot: (a) the name index — every party name of every
// kind via the match keys, matter appearances, intake appearances, and the
// names inside past check snapshots; (b) the registered-text corpus —
// trigram over current rows. The full grouped result is stored immutably
// with the exact terms: the legal record of what was seen, never
// re-resolved.
//
// Restricted handling (the pinhole rule): a hit inside a matter failing the
// runner's predicate becomes a restricted-match line — existence disclosed,
// every detail withheld, naming whom to ask per the setting
// conflict.restricted_match_contact. Each restricted matter disclosed gets a
// restricted.read register entry against that matter (surface:
// conflict_check), deduplicated per session by the marker table.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister } from '@/lib/db'
import { requireCapability, settingText } from '@/lib/ops/shared'

export interface ConflictTerms {
  name: string
  phone?: string
  email?: string
  /** Trigram similarity floor; the default mirrors the duplicate check. */
  similarity?: number
}

export interface ConflictHitGroup {
  where: 'party_names' | 'matters' | 'intakes' | 'past_check_snapshots' | 'text_corpus'
  hits: unknown[]
}

export interface ConflictRunResult {
  check: number
  groups: ConflictHitGroup[]
  restrictedMatches: { count: number; contact: string }
}

export async function runConflictCheck(
  p: Principal,
  terms: ConflictTerms,
): Promise<ConflictRunResult> {
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'conflict.run')
    const sim = terms.similarity ?? 0.4

    // ---- (a) the name index --------------------------------------------
    const partyHits = await tx.query(
      `with input as (
         select deedbox.fold_name($1) nk, deedbox.phonetic_name($1) npk
       )
       select distinct mk.party, pt.display_name, pt.state
         from deedbox.party_match_key mk
         join input i on (mk.name_key is not null and
                          (extensions.similarity(mk.name_key, i.nk) >= $2
                           or (i.npk is not null and i.npk <> '' and mk.name_phonetic = i.npk)))
         join deedbox.party pt on pt.id = mk.party
        order by mk.party`,
      [terms.name, sim],
    )
    const partyIds = partyHits.rows.map((r) => r.party as number)

    const nameRows =
      partyIds.length > 0
        ? await tx.query(
            `select pn.party, pn.name_kind, pn.full_name
               from deedbox.party_name pn where pn.party = any($1) order by pn.party, pn.id`,
            [partyIds],
          )
        : { rows: [] as Record<string, unknown>[] }

    // Matter appearances via side tables (no row security): ids first, then
    // the predicate decides which are visible and which become the pinhole.
    const matterAppearances =
      partyIds.length > 0
        ? await tx.query(
            `select distinct x.matter, x.party from (
               select mp.matter, mp.party from deedbox.matter_party mp
                where mp.party = any($1) and mp.deleted_at is null
             ) x order by x.matter`,
            [partyIds],
          )
        : { rows: [] as Record<string, unknown>[] }
    const appearanceMatterIds = [...new Set(matterAppearances.rows.map((r) => r.matter as number))]

    const intakeHits =
      partyIds.length > 0
        ? await tx.query(
            `select ir.id, ir.prospect_party, ir.state from deedbox.intake_record ir
              where ir.deleted_at is null
                and (ir.prospect_party = any($1)
                  or exists (select 1 from deedbox.intake_party ip
                              where ip.intake = ir.id and ip.party = any($1)
                                and ip.deleted_at is null))
              order by ir.id`,
            [partyIds],
          )
        : { rows: [] as Record<string, unknown>[] }

    const snapshotHits = await tx.query(
      `with input as (
         select deedbox.fold_name($1) nk, deedbox.phonetic_name($1) npk
       )
       select distinct sn."check", c.run_at
         from deedbox.conflict_snapshot_name sn
         join input i on (extensions.similarity(sn.name_key, i.nk) >= $2
                          or (i.npk is not null and i.npk <> '' and sn.name_phonetic = i.npk))
         join deedbox.conflict_check c on c.id = sn."check"
        order by sn."check"`,
      [terms.name, sim],
    )

    // ---- (b) the corpus -------------------------------------------------
    const corpusHits = await tx.query(
      `select rt.id, rt.source_module, rt.source_type, rt.matter, rt.party,
              left(rt.content, 240) as context
         from deedbox.registered_text rt
        where rt.superseded_at is null
          and rt.content operator(extensions.%) $1
        order by extensions.similarity(rt.content, $1) desc
        limit 200`,
      [terms.name],
    )
    const corpusMatterIds = [
      ...new Set(corpusHits.rows.map((r) => r.matter as number | null).filter((m) => m !== null)),
    ] as number[]

    // ---- the predicate split -------------------------------------------
    const allMatterIds = [...new Set([...appearanceMatterIds, ...corpusMatterIds])]
    const visible =
      allMatterIds.length > 0
        ? await tx.query(
            `select id, matter_number, title, status, client_party
               from deedbox.matter where id = any($1) order by id`,
            [allMatterIds],
          )
        : { rows: [] as Record<string, unknown>[] }
    const visibleIds = new Set(visible.rows.map((r) => r.id as number))
    const restrictedIds = allMatterIds.filter((m) => !visibleIds.has(m))

    const contact =
      (await settingText(tx, 'conflict.restricted_match_contact')) ?? 'role'

    // ---- assemble the grouped snapshot ---------------------------------
    const groups: ConflictHitGroup[] = [
      {
        where: 'party_names',
        hits: partyHits.rows.map((ph) => ({
          party: ph.party,
          display_name: ph.display_name,
          state: ph.state,
          names: nameRows.rows.filter((n) => n.party === ph.party),
        })),
      },
      {
        where: 'matters',
        hits: visible.rows.map((m) => ({
          matter: m.id,
          matter_number: m.matter_number,
          title: m.title,
          status: m.status,
          parties_matched: matterAppearances.rows
            .filter((a) => a.matter === m.id)
            .map((a) => a.party),
        })),
      },
      { where: 'intakes', hits: intakeHits.rows },
      { where: 'past_check_snapshots', hits: snapshotHits.rows },
      {
        where: 'text_corpus',
        hits: corpusHits.rows.filter(
          (r) => r.matter === null || visibleIds.has(r.matter as number),
        ),
      },
    ]
    const snapshot = {
      groups,
      restricted_matches: { count: restrictedIds.length, contact },
    }

    // ---- the write ------------------------------------------------------
    const check = await tx.query(
      `insert into deedbox.conflict_check (run_by, terms, result_snapshot)
       values ($1, $2, $3) returning id`,
      [p.id, JSON.stringify({ ...terms, similarity: sim }), JSON.stringify(snapshot)],
    )
    const checkId = check.rows[0].id as number

    // index the found names into the snapshot-name index for future checks
    if (partyIds.length > 0) {
      await tx.query(
        `insert into deedbox.conflict_snapshot_name ("check", name_key, name_phonetic)
         select $1, deedbox.fold_name(pn.full_name), coalesce(deedbox.phonetic_name(pn.full_name), '')
           from deedbox.party_name pn where pn.party = any($2)`,
        [checkId, partyIds],
      )
    }

    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'conflict_check',
      subject: checkId,
      detail: { terms: { name: terms.name }, restricted_matches: restrictedIds.length },
    })

    // the pinhole's register duty: one disclosure per restricted matter,
    // per-session dedup through the marker table when a session exists
    for (const m of restrictedIds) {
      if (p.session !== undefined) {
        const seen = await tx.query(
          `select 1 from deedbox.restricted_read_marker
            where session_ref = $1 and matter = $2 and surface = 'conflict_check'`,
          [p.session, m],
        )
        if (seen.rowCount! > 0) continue
        await tx.query(
          `insert into deedbox.restricted_read_marker (session_ref, matter, surface)
           values ($1, $2, 'conflict_check')`,
          [p.session, m],
        )
      }
      await emitRegister(tx, p, {
        kind: 'restricted.read',
        subjectType: 'matter',
        subject: m,
        matter: m,
        detail: { surface: 'conflict_check', check: checkId },
      })
    }

    return { check: checkId, groups, restrictedMatches: { count: restrictedIds.length, contact } }
  })
}
