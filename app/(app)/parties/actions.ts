'use server'

// Parties-area server actions: parse → named operation → notice. The
// duplicate flow is honest end-to-end: the create action re-routes to the
// candidates dialog when the check finds matches, and the operation itself
// re-runs the check inside its transaction — a stale screen cannot skip it.

import { act } from '@/lib/screens/action'
import {
  createParty,
  checkDuplicates,
  renameParty,
  addPartyName,
  addContactPoint,
  softDeleteContactPoint,
  addAddress,
  linkParties,
  createNote,
  softDeleteNote,
  commitMerge,
  undoMerge,
  type MergeDryRun,
} from '@/lib/ops/matters'
import { reviewDuplicateDecision } from '@/lib/ops/interface'
import { parse } from '@/components/forms'

function backToNew(fd: FormData): string {
  const qs = new URLSearchParams()
  for (const k of ['kind', 'full_name', 'given', 'family', 'phone', 'email', 'notes']) {
    const v = fd.get(k)
    if (typeof v === 'string' && v !== '') qs.set(k, v)
  }
  qs.set('dup', '1')
  return `goto:/parties/new?${qs.toString()}`
}

export async function addParty(formData: FormData): Promise<void> {
  await act('/parties/new', async (p) => {
    const fullName = parse.str(formData, 'full_name')
    const phone = parse.strOrNull(formData, 'phone')
    const email = parse.strOrNull(formData, 'email')
    const proceed = parse.bool(formData, 'proceed_with_candidates')

    // Run the duplicate check first; candidates send the screen to the
    // side-by-side dialog unless the user has explicitly chosen to proceed.
    const candidates = await checkDuplicates(p, {
      name: fullName,
      phone: phone ?? undefined,
      email: email ?? undefined,
    })
    if (candidates.length > 0 && !proceed) return backToNew(formData)

    const r = await createParty(p, {
      kind: (parse.str(formData, 'kind') || 'person') as 'person' | 'organisation',
      fullName,
      givenNames: parse.strOrNull(formData, 'given') ?? undefined,
      familyName: parse.strOrNull(formData, 'family') ?? undefined,
      phones: phone ? [{ value: phone, primary: true }] : undefined,
      emails: email ? [{ value: email, primary: true }] : undefined,
      notes: parse.strOrNull(formData, 'notes') ?? undefined,
      candidatesShown: candidates.length > 0 ? candidates : undefined,
    })
    return `goto:/parties/${r.id}?done=${encodeURIComponent('Party created.')}`
  })
}

export async function renamePartyAction(formData: FormData): Promise<void> {
  const party = parse.num(formData, 'party')
  await act(`/parties/${party}`, async (p) => {
    await renameParty(p, {
      party,
      fullName: parse.str(formData, 'full_name'),
      givenNames: parse.strOrNull(formData, 'given') ?? undefined,
      familyName: parse.strOrNull(formData, 'family') ?? undefined,
    })
    return 'Renamed — the previous name is kept and still searchable.'
  })
}

export async function addNameAction(formData: FormData): Promise<void> {
  const party = parse.num(formData, 'party')
  await act(`/parties/${party}`, async (p) => {
    await addPartyName(p, {
      party,
      nameKind: parse.str(formData, 'name_kind') as 'former' | 'also_known_as' | 'trading',
      fullName: parse.str(formData, 'full_name'),
    })
    return 'Name added.'
  })
}

export async function addContactAction(formData: FormData): Promise<void> {
  const party = parse.num(formData, 'party')
  await act(`/parties/${party}`, async (p) => {
    await addContactPoint(p, {
      party,
      kind: parse.str(formData, 'contact_kind') as 'phone' | 'email',
      value: parse.str(formData, 'value'),
      label: parse.strOrNull(formData, 'label') ?? undefined,
      primary: parse.bool(formData, 'primary'),
    })
    return 'Contact added.'
  })
}

export async function removeContactAction(formData: FormData): Promise<void> {
  const party = parse.num(formData, 'party')
  await act(`/parties/${party}`, async (p) => {
    await softDeleteContactPoint(p, { party, contactPoint: parse.num(formData, 'contact') })
    return 'Contact removed (recoverable from Deleted records).'
  })
}

export async function addAddressAction(formData: FormData): Promise<void> {
  const party = parse.num(formData, 'party')
  await act(`/parties/${party}`, async (p) => {
    await addAddress(p, {
      party,
      kind: (parse.str(formData, 'address_kind') || 'postal') as
        | 'postal'
        | 'street'
        | 'billing'
        | 'other',
      lines: parse.strOrNull(formData, 'lines') ?? undefined,
      locality: parse.strOrNull(formData, 'locality') ?? undefined,
      region: parse.strOrNull(formData, 'region') ?? undefined,
      postcode: parse.strOrNull(formData, 'postcode') ?? undefined,
      country: parse.strOrNull(formData, 'country') ?? undefined,
    })
    return 'Address added.'
  })
}

export async function linkPartiesAction(formData: FormData): Promise<void> {
  const party = parse.num(formData, 'party')
  await act(`/parties/${party}`, async (p) => {
    await linkParties(p, {
      fromParty: party,
      toParty: parse.num(formData, 'to_party'),
      linkKind: parse.num(formData, 'link_kind'),
      note: parse.strOrNull(formData, 'note') ?? undefined,
    })
    return 'Parties linked.'
  })
}

export async function addPartyNoteAction(formData: FormData): Promise<void> {
  const party = parse.num(formData, 'party')
  await act(`/parties/${party}`, async (p) => {
    await createNote(p, { ownerType: 'party', owner: party, body: parse.str(formData, 'body') })
    return 'Note added.'
  })
}

export async function removePartyNoteAction(formData: FormData): Promise<void> {
  const party = parse.num(formData, 'party')
  await act(`/parties/${party}`, async (p) => {
    await softDeleteNote(p, { note: parse.num(formData, 'note') })
    return 'Note removed (recoverable from Deleted records).'
  })
}

export async function commitMergeAction(formData: FormData): Promise<void> {
  const survivor = parse.num(formData, 'survivor')
  const absorbed = parse.num(formData, 'absorbed')
  await act(`/parties/${survivor}/merge?absorbed=${absorbed}`, async (p) => {
    // The merge commit demands the PRESENTED dry-run: the operation verifies the world
    // still matches what the user saw before anything moves.
    const dryRun = JSON.parse(parse.str(formData, 'dry_run')) as MergeDryRun
    const r = await commitMerge(p, { survivor, absorbed, dryRun })
    return `goto:/parties/${survivor}?done=${encodeURIComponent(
      `Merged. Everything now points at this party (run #${r.bulkOperation}); undo stays open for the window.`,
    )}`
  })
}

export async function undoMergeAction(formData: FormData): Promise<void> {
  const survivor = parse.num(formData, 'survivor')
  await act(`/parties/${survivor}`, async (p) => {
    const r = await undoMerge(p, {
      merge: parse.num(formData, 'merge'),
      reason: parse.str(formData, 'reason'),
    })
    return r.undone
      ? 'Merge undone — every moved row is back.'
      : `The merge stands: ${r.blocked} item(s) were touched since and blocked the reversal (itemised on the run).`
  })
}

export async function confirmDuplicateAction(formData: FormData): Promise<void> {
  await act('/parties/review', async (p) => {
    await reviewDuplicateDecision(p, { decision: parse.num(formData, 'decision') })
    return 'Reviewed — the record stands as created.'
  })
}

// --- client portal invites ---

export async function createPortalInviteAction(formData: FormData): Promise<void> {
  const party = parse.num(formData, 'party')
  await act(`/parties/${party}`, async (p) => {
    const { createPortalInvite } = await import('@/lib/ops/portal')
    const r = await createPortalInvite(p, {
      party,
      email: parse.str(formData, 'email'),
      expiresDays: parse.numOrNull(formData, 'expires_days') ?? undefined,
    })
    const { headers } = await import('next/headers')
    const h = await headers()
    const proto = h.get('x-forwarded-proto') ?? 'https'
    const host = h.get('x-forwarded-host') ?? h.get('host') ?? ''
    const origin = host ? `${proto}://${host}` : ''
    return `Portal invitation created. COPY THE LINK NOW — it is shown once and never again: ${origin}/portal/accept/${r.token}`
  })
}

export async function revokePortalInviteAction(formData: FormData): Promise<void> {
  const party = parse.num(formData, 'party')
  await act(`/parties/${party}`, async (p) => {
    const { revokePortalInvite } = await import('@/lib/ops/portal')
    await revokePortalInvite(p, { invite: parse.num(formData, 'invite') })
    return 'Invitation revoked — any live portal sessions for this client were ended with it.'
  })
}
