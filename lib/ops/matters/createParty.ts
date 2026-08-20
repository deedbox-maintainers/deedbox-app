// Create party, one transaction. Match keys, the text corpus (party notes)
// and the search index are maintained by the schema's synchronous triggers;
// this operation writes the rows, the duplicate decision when candidates
// were shown, and the register entry. Custom-field values arrive with the
// configuration slice (a recorded implementation choice).

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { checkDuplicatesInTx } from './duplicates'

export interface ContactInput {
  value: string
  label?: string
  primary?: boolean
}

export interface AddressInput {
  kind?: 'postal' | 'street' | 'billing' | 'other'
  lines?: string
  locality?: string
  region?: string
  postcode?: string
  country?: string
}

export interface CreatePartyInput {
  kind: 'person' | 'organisation'
  fullName: string
  givenNames?: string
  familyName?: string
  orgName?: string
  phones?: ContactInput[]
  emails?: ContactInput[]
  addresses?: AddressInput[]
  notes?: string
  /**
   * The duplicate dialog's outcome. The screen flow runs
   * checkDuplicates first; when candidates were shown and the user chose to
   * proceed, they are recorded here as the permanent duplicate decision.
   * The operation re-runs the check inside its transaction: fresh candidates
   * with no recorded decision refuse the create — abandoning at the dialog
   * writes nothing, and a stale screen cannot skip it.
   */
  candidatesShown?: unknown[]
}

export async function createParty(
  p: Principal,
  input: CreatePartyInput,
): Promise<{ id: number }> {
  requireStaff(p)
  const fullName = input.fullName.trim()
  if (!fullName) throw new OperationRefused('name_required', 'a party needs a name')
  for (const list of [input.phones ?? [], input.emails ?? []]) {
    if (list.filter((c) => c.primary).length > 1) {
      throw new OperationRefused('one_primary', 'at most one primary contact per kind')
    }
  }

  return withPrincipal(p, async (tx) => {
    const candidates = await checkDuplicatesInTx(tx, {
      name: fullName,
      phone: input.phones?.[0]?.value,
      email: input.emails?.[0]?.value,
    })
    if (candidates.length > 0 && input.candidatesShown === undefined) {
      throw new OperationRefused(
        'duplicates_found',
        'possible existing parties were found; review the candidates and proceed deliberately',
      )
    }

    const party = await tx.query(
      `insert into deedbox.party (kind, display_name, notes)
       values ($1, $2, $3) returning id`,
      [input.kind, fullName, input.notes ?? null],
    )
    const partyId = party.rows[0].id as number

    await tx.query(
      `insert into deedbox.party_name (party, name_kind, full_name, given_names, family_name, org_name)
       values ($1, 'current', $2, $3, $4, $5)`,
      [
        partyId,
        fullName,
        input.kind === 'person' ? (input.givenNames ?? null) : null,
        input.kind === 'person' ? (input.familyName ?? null) : null,
        input.kind === 'organisation' ? (input.orgName ?? fullName) : null,
      ],
    )

    for (const [kind, list] of [
      ['phone', input.phones ?? []],
      ['email', input.emails ?? []],
    ] as const) {
      for (const c of list) {
        await tx.query(
          `insert into deedbox.contact_point (party, kind, value, label, is_primary)
           values ($1, $2, $3, $4, $5)`,
          [partyId, kind, c.value, c.label ?? null, c.primary ?? false],
        )
      }
    }
    for (const a of input.addresses ?? []) {
      await tx.query(
        `insert into deedbox.postal_address (party, kind, lines, locality, region, postcode, country)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          partyId,
          a.kind ?? 'postal',
          a.lines ?? null,
          a.locality ?? null,
          a.region ?? null,
          a.postcode ?? null,
          a.country ?? null,
        ],
      )
    }

    if (input.candidatesShown !== undefined) {
      await tx.query(
        `insert into deedbox.duplicate_decision
           (created_entity_type, created_entity, candidates_shown, decision_mode, decided_by_kind, decided_by)
         values ('party', $1, $2, 'interactive', 'staff', $3)`,
        [partyId, JSON.stringify(input.candidatesShown), p.id],
      )
    }

    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'party',
      subject: partyId,
      detail: { kind: input.kind, display_name: fullName },
    })
    return { id: partyId }
  })
}
