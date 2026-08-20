'use server'

// Matters-area server actions. Thin parsers over the domain operations; the
// multi-select bulk flow serialises the PRESENTED dry-run into the commit so
// the machinery's before-state verification judges exactly what the user saw
// (a changed item forces re-preparation — never a silent divergence).

import { act } from '@/lib/screens/action'
import {
  createMatter,
  closeMatter,
  approveCloseRequest,
  rejectCloseRequest,
  withdrawCloseRequest,
  reopenMatter,
  archiveMatter,
  holdMatter,
  resumeMatter,
  addMatterParty,
  updateMatterDetails,
  setPortalAccess,
  softDeleteMatterParty,
  changeClient,
  relateMatters,
  unrelateMatters,
  changeStaffing,
  changeRestriction,
  createNote,
  softDeleteNote,
  type RestrictionChange,
} from '@/lib/ops/matters'
import { commitBulk, reverseBulk, type BulkDryRun } from '@/lib/ops/bulk'
import { parse } from '@/components/forms'

export async function addMatter(formData: FormData): Promise<void> {
  await act('/matters/new', async (p) => {
    const conflictCheck = parse.numOrNull(formData, 'conflict_check')
    const r = await createMatter(p, {
      title: parse.str(formData, 'title'),
      clientParty: parse.num(formData, 'client_party'),
      responsibleLawyer: parse.num(formData, 'responsible_lawyer'),
      office: parse.num(formData, 'office'),
      practiceArea: parse.num(formData, 'practice_area'),
      jurisdiction: parse.strOrNull(formData, 'jurisdiction') ?? undefined,
      summary: parse.strOrNull(formData, 'summary') ?? undefined,
      originNote: parse.strOrNull(formData, 'origin_note') ?? undefined,
      conflictCheck: conflictCheck ?? undefined,
    })
    return `goto:/matters/${r.id}?done=${encodeURIComponent(`Matter ${r.matterNumber} opened.`)}`
  })
}

export async function closeMatterAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/close`, async (p) => {
    const r = await closeMatter(p, {
      matter,
      note: parse.strOrNull(formData, 'note') ?? undefined,
    })
    return r.closed
      ? `goto:/matters/${matter}?done=${encodeURIComponent('Matter closed.')}`
      : `Close request #${r.pendingRequest} submitted — another matter.close holder must approve it.`
  })
}

export async function approveCloseAction(formData: FormData): Promise<void> {
  await act('/matters/approvals', async (p) => {
    await approveCloseRequest(p, {
      request: parse.num(formData, 'request'),
      note: parse.strOrNull(formData, 'note') ?? undefined,
    })
    return 'Approved — the matter is closed.'
  })
}

export async function rejectCloseAction(formData: FormData): Promise<void> {
  await act('/matters/approvals', async (p) => {
    await rejectCloseRequest(p, {
      request: parse.num(formData, 'request'),
      note: parse.str(formData, 'note'),
    })
    return 'Rejected — the matter stays open.'
  })
}

export async function withdrawCloseAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/close`, async (p) => {
    await withdrawCloseRequest(p, { request: parse.num(formData, 'request') })
    return 'Request withdrawn.'
  })
}

export async function reopenAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}`, async (p) => {
    await reopenMatter(p, { matter, reason: parse.str(formData, 'reason') })
    return 'Reopened.'
  })
}

export async function archiveAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}`, async (p) => {
    await archiveMatter(p, { matter })
    return 'Archived.'
  })
}

export async function holdAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}`, async (p) => {
    await holdMatter(p, { matter })
    return 'On hold.'
  })
}

export async function resumeAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}`, async (p) => {
    await resumeMatter(p, { matter })
    return 'Resumed.'
  })
}

export async function updateMatterDetailsAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}`, async (p) => {
    await updateMatterDetails(p, {
      matter,
      title: parse.str(formData, 'title'),
      summary: parse.strOrNull(formData, 'summary'),
    })
    return 'Details amended — the change is on the register.'
  })
}

export async function addMatterPartyAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}`, async (p) => {
    await addMatterParty(p, {
      matter,
      party: parse.num(formData, 'party'),
      capacity: parse.num(formData, 'capacity'),
      note: parse.strOrNull(formData, 'note') ?? undefined,
    })
    return 'Party added.'
  })
}

export async function removeMatterPartyAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}`, async (p) => {
    await softDeleteMatterParty(p, { matterParty: parse.num(formData, 'matter_party') })
    return 'Party removed from the matter.'
  })
}

export async function setPortalAccessAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}`, async (p) => {
    const on = parse.bool(formData, 'portal_access')
    await setPortalAccess(p, { matterParty: parse.num(formData, 'matter_party'), portalAccess: on })
    return on ? 'Portal access granted.' : 'Portal access removed.'
  })
}

export async function changeClientAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}`, async (p) => {
    await changeClient(p, { matter, newClient: parse.num(formData, 'new_client') })
    return 'Client changed — the previous client stays on the matter as a related party.'
  })
}

export async function relateAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}`, async (p) => {
    await relateMatters(p, {
      matterA: matter,
      matterB: parse.num(formData, 'other_matter'),
      label: parse.num(formData, 'label'),
    })
    return 'Matters related.'
  })
}

export async function unrelateAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}`, async (p) => {
    await unrelateMatters(p, { relation: parse.num(formData, 'relation') })
    return 'Relation removed.'
  })
}

export async function addMatterNoteAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}`, async (p) => {
    await createNote(p, { ownerType: 'matter', owner: matter, body: parse.str(formData, 'body') })
    return 'Note added.'
  })
}

export async function removeMatterNoteAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}`, async (p) => {
    await softDeleteNote(p, { note: parse.num(formData, 'note') })
    return 'Note removed (recoverable from Deleted records).'
  })
}

export async function changeStaffingAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/staffing`, async (p) => {
    const end = formData
      .getAll('end')
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0)
    const addAssisting = parse.numOrNull(formData, 'add_assisting')
    const newResponsible = parse.numOrNull(formData, 'new_responsible')
    await changeStaffing(p, {
      matter,
      end: end.length > 0 ? end : undefined,
      addAssisting: addAssisting ? [addAssisting] : undefined,
      newResponsible: newResponsible ?? undefined,
    })
    return 'Staffing changed — any task re-assignment proposal is raised for confirmation.'
  })
}

function parseRestrictionChange(fd: FormData): RestrictionChange {
  const action = parse.str(fd, 'change_action')
  if (action === 'add_grant' || action === 'remove_grant') {
    return {
      action,
      granteeKind: parse.str(fd, 'grantee_kind') as 'staff' | 'role',
      grantee: parse.num(fd, 'grantee'),
    }
  }
  if (action === 'add_block' || action === 'remove_block') {
    return { action, staff: parse.num(fd, 'staff') }
  }
  throw new Error(`unknown restriction change action: ${action}`)
}

/** Step 1 of the restriction flow: send the proposed change to the preview
 * (the dry-run delta renders on the panel — nothing written). */
export async function previewRestrictionAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/restriction`, async () => {
    const qs = new URLSearchParams()
    for (const k of ['change_action', 'grantee_kind', 'grantee', 'staff']) {
      const v = formData.get(k)
      if (typeof v === 'string' && v !== '') qs.set(k, v)
    }
    return `goto:/matters/${matter}/restriction?${qs.toString()}`
  })
}

/** Step 2: commit the previewed change (reason never negotiable). */
export async function commitRestrictionAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/restriction`, async (p) => {
    await changeRestriction(p, {
      matter,
      change: parseRestrictionChange(formData),
      reason: parse.str(formData, 'reason'),
    })
    return 'Restriction changed — the register carries who could see it before and after.'
  })
}

/** Multi-select step 1: run the dry-run and land on the confirmation screen. */
export async function bulkPrepareAction(formData: FormData): Promise<void> {
  await act('/matters', async () => {
    const kind = parse.str(formData, 'kind')
    const matters = formData
      .getAll('matters')
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0)
    if (matters.length === 0) return 'goto:/matters?refused=Select at least one matter first.'
    const qs = new URLSearchParams({ kind, matters: matters.join(',') })
    return `goto:/matters/bulk?${qs.toString()}`
  })
}

/** Multi-select step 2: commit exactly the presented dry-run. */
export async function bulkCommitAction(formData: FormData): Promise<void> {
  await act('/matters', async (p) => {
    const dryRun = JSON.parse(parse.str(formData, 'dry_run')) as BulkDryRun
    const r = await commitBulk(p, {
      dryRun,
      reason: parse.strOrNull(formData, 'reason') ?? undefined,
    })
    return `goto:/matters/bulk/${r.bulkOperation}?done=${encodeURIComponent(
      `Done: ${r.executed} matter(s) changed, ${r.skipped} skipped as itemised.`,
    )}`
  })
}

export async function bulkReverseAction(formData: FormData): Promise<void> {
  const run = parse.num(formData, 'run')
  await act(`/matters/bulk/${run}`, async (p) => {
    const r = await reverseBulk(p, { bulkOperation: run, reason: parse.str(formData, 'reason') })
    return r.blocked === 0
      ? `Fully reversed: ${r.reversed} matter(s) restored.`
      : `${r.reversed} reversed, ${r.blocked} blocked (touched since — itemised below).`
  })
}

// --- matter email + calendar ---

export async function sendMatterEmailAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/email`, async (p) => {
    const { sendMatterEmail } = await import('@/lib/ops/m365')
    const to = parse
      .str(formData, 'to')
      .split(/[,;]/)
      .map((a) => a.trim())
      .filter(Boolean)
    const ccRaw = (formData.get('cc') as string) || ''
    const cc = ccRaw
      .split(/[,;]/)
      .map((a) => a.trim())
      .filter(Boolean)
    await sendMatterEmail(p, {
      matter,
      to,
      cc: cc.length ? cc : undefined,
      subject: parse.str(formData, 'subject'),
      bodyHtml: parse.str(formData, 'body').replace(/\n/g, '<br/>'),
    })
    return 'Sent as you, and filed on the matter.'
  })
}

export async function createCalendarEventAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/email`, async (p) => {
    const { createMatterCalendarEvent } = await import('@/lib/ops/m365')
    await createMatterCalendarEvent(p, {
      matter,
      subject: parse.str(formData, 'subject'),
      startsAt: new Date(parse.str(formData, 'starts_at')).toISOString(),
      endsAt: (formData.get('ends_at') as string)
        ? new Date(formData.get('ends_at') as string).toISOString()
        : undefined,
      location: (formData.get('location') as string) || undefined,
    })
    return 'Created in your calendar and recorded on the matter.'
  })
}

export async function ensureFilingTokenAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/documents`, async (p) => {
    const { ensureFilingToken } = await import('@/lib/ops/m365')
    await ensureFilingToken(p, { matter })
    return 'Email filing address created for this matter.'
  })
}
