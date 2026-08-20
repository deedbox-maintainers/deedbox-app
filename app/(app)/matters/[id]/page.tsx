// The matter hub: header, live position (the display cache), parties,
// staffing, relations (far side predicate-gated, masked when invisible),
// custom fields, notes, and the timeline — the register projection over
// timeline-eligible events. Opening a restricted matter is a recorded
// disclosure before anything renders.

import Link from 'next/link'
import { requirePrincipal } from '@/lib/auth'
import { recordView } from '@/lib/ops/reports'
import { matterHub, matterFilterOptions, mattersViewerFlags } from '@/lib/reads/matters'
import { Page, Panel, DataTable, DetailList, Notices, RowLink, Badge, EmptyState, fmtDate, fmtDateTime } from '@/components/ui'
import { Field, TextInput, TextArea, Select, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { pinAction } from '../../actions'
import {
  addMatterPartyAction,
  removeMatterPartyAction,
  updateMatterDetailsAction,
  setPortalAccessAction,
  changeClientAction,
  relateAction,
  unrelateAction,
  addMatterNoteAction,
  removeMatterNoteAction,
  reopenAction,
  archiveAction,
  holdAction,
  resumeAction,
} from '../actions'

const STATUS_TONES: Record<string, 'green' | 'amber' | 'neutral'> = {
  open: 'green',
  on_hold: 'amber',
  closed: 'neutral',
  archived: 'neutral',
}

const TIMELINE_TONES: Record<string, 'blue' | 'green' | 'amber' | 'neutral' | 'violet'> = {
  financial: 'green',
  note: 'blue',
  task: 'amber',
  key_date: 'amber',
  administrative: 'neutral',
}

export default async function MatterHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const [hub, options, flags] = await Promise.all([
    matterHub(p, Number(id)),
    matterFilterOptions(p),
    mattersViewerFlags(p),
  ])
  const m = hub.matter
  const openish = m.status === 'open' || m.status === 'on_hold'
  await recordView(p, { itemType: 'matter', item: Number(id) }) // feeds recents

  return (
    <Page
      title={`${m.matterNumber} — ${m.title}`}
      lead={
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONES[m.status] ?? 'neutral'}>{m.status.replace('_', ' ')}</Badge>
          {m.restricted ? <Badge tone="violet">restricted</Badge> : null}
          {m.billingHold ? <Badge tone="amber">billing hold</Badge> : null}
          <span>
            {m.area.name} · {m.office.name} · opened {fmtDate(m.openedDate)}
            {m.closedDate ? ` · closed ${fmtDate(m.closedDate)}` : ''}
          </span>
        </span>
      }
      actions={
        <span className="flex items-center gap-2">
          {openish && flags.close ? (
            <Link
              href={`/matters/${m.id}/close`}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
            >
              Close matter…
            </Link>
          ) : null}
          {flags.restriction ? (
            <Link
              href={`/matters/${m.id}/restriction`}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
            >
              Restriction
            </Link>
          ) : null}
          <Link
            href={`/matters/${m.id}/staffing`}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            Staffing
          </Link>
          <Link
            href={`/matters/${m.id}/billing`}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            Billing
          </Link>
          <Link
            href={`/matters/${m.id}/money`}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            Client money
          </Link>
          <Link
            href={`/matters/${m.id}/workflow`}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            Workflow
          </Link>
          <Link
            href={`/matters/${m.id}/documents`}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            Documents
          </Link>
          <Link
            href={`/matters/${m.id}/email`}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            Email
          </Link>
          <form action={pinAction}>
            <input type="hidden" name="item_type" value="matter" />
            <input type="hidden" name="item" value={String(m.id)} />
            <input type="hidden" name="back" value={`/matters/${m.id}`} />
            <button
              type="submit"
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
            >
              Pin
            </button>
          </form>
        </span>
      }
    >
      <Notices searchParams={sp} />

      {hub.pendingCloseRequest ? (
        <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Close request #{hub.pendingCloseRequest.id} by {hub.pendingCloseRequest.requesterName} is
          awaiting approval — <RowLink href="/matters/approvals">the approval queue</RowLink>.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <div>
          <Panel title="Overview">
            <DetailList
              items={[
                ['Client', <RowLink key="c" href={`/parties/${hub.matter.client.id}`}>{hub.matter.client.name}</RowLink>],
                ['Responsible lawyer', hub.matter.lawyer.name],
                ['Previous system number', m.priorReference ?? '—'],
                ['Jurisdiction', m.jurisdiction ?? '—'],
                ['Summary', m.summary ?? '—'],
                ['Origin note (descriptive only)', m.originNote ?? '—'],
              ]}
            />
            {openish ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-sky-700">Amend details</summary>
                <form action={updateMatterDetailsAction} className="mt-3 max-w-lg">
                  <input type="hidden" name="matter" value={m.id} />
                  <Field label="Title">
                    <TextInput name="title" required defaultValue={String(m.title ?? '')} />
                  </Field>
                  <Field label="Summary" hint="Leave blank to clear">
                    <TextArea name="summary" defaultValue={String(m.summary ?? '')} />
                  </Field>
                  <SubmitButton tone="quiet">Amend details</SubmitButton>
                </form>
              </details>
            ) : null}
          </Panel>

          <Panel
            title="Working position"
            actions={
              openish && flags.close ? (
                <Link href={`/matters/${m.id}/close`} className="text-sm text-sky-700 hover:underline">
                  Live figures on the close screen
                </Link>
              ) : undefined
            }
          >
            {hub.position === null ? (
              <EmptyState>No cached figures yet — they appear as work is recorded.</EmptyState>
            ) : (
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-md border border-neutral-100 bg-neutral-50 p-3">
                  <p className="text-xs text-neutral-500">Unbilled work</p>
                  <p className="text-lg font-semibold tabular-nums">{hub.position.unbilled.toFixed(2)}</p>
                </div>
                <div className="rounded-md border border-neutral-100 bg-neutral-50 p-3">
                  <p className="text-xs text-neutral-500">Outstanding bills</p>
                  <p className="text-lg font-semibold tabular-nums">{hub.position.outstanding.toFixed(2)}</p>
                </div>
                <div className="rounded-md border border-neutral-100 bg-neutral-50 p-3">
                  <p className="text-xs text-neutral-500">Held for the client (available)</p>
                  <p className="text-lg font-semibold tabular-nums">{hub.position.heldAvailable.toFixed(2)}</p>
                </div>
              </div>
            )}
            <p className="mt-2 text-xs text-neutral-400">
              Display figures from the maintained cache — every figure of record is computed fresh
              where it matters (the close screen, the ledgers, the bills).
            </p>
          </Panel>

          <Panel title="Parties">
            <DataTable
              headers={['Party', 'Capacity', 'Portal', '', '']}
              rows={hub.parties.map((mp) => [
                <span key="n">
                  <RowLink href={`/parties/${mp.party}`}>{mp.name}</RowLink>
                  {mp.merged ? <Badge tone="neutral"> merged</Badge> : null}
                </span>,
                mp.capacity,
                mp.portalAccess ? <Badge key="pa" tone="blue">portal</Badge> : '',
                openish ? (
                  <InlineAction
                    key="portal"
                    action={setPortalAccessAction}
                    fields={{
                      matter: m.id,
                      matter_party: mp.id,
                      portal_access: mp.portalAccess ? '' : 'on',
                    }}
                    label={mp.portalAccess ? 'Remove portal' : 'Grant portal'}
                  />
                ) : (
                  ''
                ),
                openish ? (
                  // The automatic client row refuses removal with its own
                  // words — the operation owns that rule, not this screen.
                  <InlineAction
                    key="rm"
                    action={removeMatterPartyAction}
                    fields={{ matter: m.id, matter_party: mp.id }}
                    label="Remove"
                  />
                ) : (
                  ''
                ),
              ])}
            />
            {openish ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-sky-700">
                  Add party / change client
                </summary>
                <div className="mt-3 grid grid-cols-1 gap-6 md:grid-cols-2">
                  <form action={addMatterPartyAction} className="max-w-xs">
                    <input type="hidden" name="matter" value={m.id} />
                    <Field label="Party #" hint="From their profile — the duplicate check runs on creation">
                      <TextInput name="party" required inputMode="numeric" />
                    </Field>
                    <Field label="Capacity">
                      <Select name="capacity">
                        {options.capacities
                          .filter((c) => c.label.toLowerCase() !== 'client')
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                            </option>
                          ))}
                      </Select>
                    </Field>
                    <SubmitButton tone="quiet">Add party</SubmitButton>
                  </form>
                  <form action={changeClientAction} className="max-w-xs">
                    <input type="hidden" name="matter" value={m.id} />
                    <Field
                      label="New client (party #)"
                      hint="The current client stays on the matter as a related party"
                    >
                      <TextInput name="new_client" required inputMode="numeric" />
                    </Field>
                    <SubmitButton tone="quiet">Change client</SubmitButton>
                  </form>
                </div>
              </details>
            ) : null}
          </Panel>

          <Panel title="Related matters">
            <DataTable
              headers={['Relation', 'Matter', '', '']}
              rows={hub.relations.map((r) => [
                r.label,
                r.visible ? (
                  <RowLink key="m" href={`/matters/${r.farMatter}`}>
                    {r.farNumber} — {r.farTitle}
                  </RowLink>
                ) : (
                  <span key="m" className="text-neutral-400">
                    a matter you cannot see
                  </span>
                ),
                '',
                openish ? (
                  <InlineAction
                    key="rm"
                    action={unrelateAction}
                    fields={{ matter: m.id, relation: r.id }}
                    label="Unrelate"
                  />
                ) : (
                  ''
                ),
              ])}
              emptyState="No related matters."
            />
            {openish ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-sky-700">Relate a matter</summary>
                <form action={relateAction} className="mt-3 max-w-xs">
                  <input type="hidden" name="matter" value={m.id} />
                  <Field label="Other matter #">
                    <TextInput name="other_matter" required inputMode="numeric" />
                  </Field>
                  <Field label="Relation label">
                    <Select name="label">
                      {options.relationLabels.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <SubmitButton tone="quiet">Relate</SubmitButton>
                </form>
              </details>
            ) : null}
          </Panel>

          {hub.customFields.length > 0 ? (
            <Panel title="Custom fields">
              <DetailList items={hub.customFields.map((f) => [f.label, String(f.value ?? '—')])} />
            </Panel>
          ) : null}

          <Panel title="Status">
            <div className="flex flex-wrap items-center gap-3">
              {m.status === 'open' ? (
                <InlineAction action={holdAction} fields={{ matter: m.id }} label="Put on hold" />
              ) : null}
              {m.status === 'on_hold' ? (
                <InlineAction action={resumeAction} fields={{ matter: m.id }} label="Resume" />
              ) : null}
              {m.status === 'closed' && flags.close ? (
                <InlineAction action={archiveAction} fields={{ matter: m.id }} label="Archive" />
              ) : null}
              {(m.status === 'closed' || m.status === 'archived') && flags.reopen ? (
                <form action={reopenAction} className="flex items-end gap-2">
                  <input type="hidden" name="matter" value={m.id} />
                  <div className="w-64">
                    <Field label="Reopen — reason (always recorded)">
                      <TextInput name="reason" required />
                    </Field>
                  </div>
                  <div className="pb-3">
                    <SubmitButton tone="quiet">Reopen</SubmitButton>
                  </div>
                </form>
              ) : null}
              {m.status === 'closed' || m.status === 'archived' ? (
                <p className="text-xs text-neutral-400">
                  A {m.status} matter is read-only — every change needs the closed-matter ceremony.
                </p>
              ) : null}
            </div>
          </Panel>
        </div>

        <div>
          <Panel title="Timeline">
            {hub.timeline.length === 0 ? (
              <EmptyState>Nothing recorded yet.</EmptyState>
            ) : (
              <ul className="space-y-2">
                {hub.timeline.map((t) => (
                  <li key={t.id} className="flex items-start gap-2 border-b border-neutral-50 pb-2 text-sm">
                    <Badge tone={TIMELINE_TONES[t.timelineKind ?? 'administrative'] ?? 'neutral'}>
                      {(t.timelineKind ?? 'event').replace('_', ' ')}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-neutral-800">
                        {t.eventKind.replace('.', ' — ').replace(/_/g, ' ')}
                        {t.reason ? <span className="text-neutral-500"> · {t.reason}</span> : null}
                      </p>
                      <p className="text-xs text-neutral-400">
                        {fmtDateTime(t.occurredAt)} · {t.actorName}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Notes">
            {hub.notes.length === 0 ? (
              <EmptyState>No notes yet.</EmptyState>
            ) : (
              <ul className="space-y-3">
                {hub.notes.map((n) => (
                  <li key={n.id} className="rounded-md border border-neutral-100 bg-neutral-50 p-3 text-sm">
                    <p className="whitespace-pre-wrap text-neutral-800">{n.body}</p>
                    <div className="mt-1 flex items-center justify-between text-xs text-neutral-400">
                      <span>
                        {fmtDateTime(n.notedAt)}
                        {n.authorName ? ` — ${n.authorName}` : ''}
                      </span>
                      {openish ? (
                        <InlineAction
                          action={removeMatterNoteAction}
                          fields={{ matter: m.id, note: n.id }}
                          label="Remove"
                        />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {openish ? (
              <form action={addMatterNoteAction} className="mt-3">
                <input type="hidden" name="matter" value={m.id} />
                <Field label="New note">
                  <TextArea name="body" rows={2} required />
                </Field>
                <SubmitButton tone="quiet">Add note</SubmitButton>
              </form>
            ) : null}
          </Panel>

          <Panel title="Staffing">
            <DataTable
              headers={['Who', 'Role', 'Since']}
              rows={hub.staffing
                .filter((s) => s.toAt === null)
                .map((s) => [s.name, s.role.replace(/_/g, ' '), fmtDateTime(s.fromAt)])}
            />
            <p className="mt-2 text-sm">
              <RowLink href={`/matters/${m.id}/staffing`}>Full staffing history and changes</RowLink>
            </p>
          </Panel>
        </div>
      </div>
    </Page>
  )
}
