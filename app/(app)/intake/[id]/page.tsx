// The intake record screen: parties, notes, attached conflict checks,
// stage/outcome controls, and the conversion — one act carrying everything
// across, never a half-converted pair.

import { requirePrincipal } from '@/lib/auth'
import { intakeRecord, intakeBoard, matterFilterOptions, mattersViewerFlags } from '@/lib/reads/matters'
import { Page, Panel, DataTable, DetailList, Notices, RowLink, Badge, EmptyState, fmtDateTime } from '@/components/ui'
import { Field, TextInput, TextArea, Select, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  moveStageAction,
  setOutcomeAction,
  closeIntakeAction,
  reopenIntakeAction,
  addIntakePartyAction,
  removeIntakePartyAction,
  addIntakeNoteAction,
  removeIntakeNoteAction,
  convertIntakeAction,
} from '../actions'

export default async function IntakeRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const [data, board, options, flags] = await Promise.all([
    intakeRecord(p, Number(id)),
    intakeBoard(p, {}),
    matterFilterOptions(p),
    mattersViewerFlags(p),
  ])
  const r = data.record
  const open = r.state === 'open'

  return (
    <Page
      title={`Approach — ${r.prospectName}`}
      lead={
        <span className="flex flex-wrap items-center gap-2">
          {r.state === 'converted' ? (
            <RowLink href={`/matters/${r.convertedMatter}`}>
              <Badge tone="green">converted → {r.convertedNumber}</Badge>
            </RowLink>
          ) : (
            <Badge tone={open ? 'blue' : 'neutral'}>{r.state}</Badge>
          )}
          <span>recorded {fmtDateTime(r.createdAt)}</span>
        </span>
      }
    >
      <Notices searchParams={sp} />

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <div>
          <Panel title="Details">
            <DetailList
              items={[
                ['Prospect', <RowLink key="p" href={`/parties/${r.prospectParty}`}>{r.prospectName}</RowLink>],
                ['Phone', r.contactPhone],
                ['Email', r.contactEmail ?? '—'],
                ['About', r.about],
                ['Notes', r.notesText ?? '—'],
                ['Practice area', r.areaName ?? '—'],
                ['Stage', r.stageName ?? '—'],
                [
                  'Outcome',
                  r.outcomeLabel ? `${r.outcomeLabel}${r.outcomeNote ? ` — ${r.outcomeNote}` : ''}` : 'none recorded',
                ],
              ]}
            />
          </Panel>

          {open ? (
            <Panel title="Stage & outcome">
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <form action={moveStageAction}>
                  <input type="hidden" name="intake" value={r.id} />
                  <Field label="Move to stage">
                    <Select name="stage" defaultValue={r.stage ?? ''}>
                      {board.stages
                        .filter((s) => s.active)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <SubmitButton tone="quiet">Move</SubmitButton>
                </form>
                <form action={setOutcomeAction}>
                  <input type="hidden" name="intake" value={r.id} />
                  <Field label="Outcome" hint="Never demanded; clear it any time">
                    <Select name="outcome_reason" defaultValue={r.outcomeReason ?? ''}>
                      <option value="">(clear)</option>
                      {options.intakeOutcomes.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Outcome note">
                    <TextInput name="outcome_note" defaultValue={r.outcomeNote ?? ''} />
                  </Field>
                  <SubmitButton tone="quiet">Record outcome</SubmitButton>
                </form>
              </div>
              <div className="mt-4 border-t border-neutral-100 pt-3">
                <InlineAction action={closeIntakeAction} fields={{ intake: r.id }} label="Close without converting" />
              </div>
            </Panel>
          ) : r.state === 'closed' ? (
            <Panel title="Reopen">
              <InlineAction action={reopenIntakeAction} fields={{ intake: r.id }} label="Reopen" />
            </Panel>
          ) : null}

          <Panel title="Conflict checks">
            <DataTable
              headers={['Check', 'Run', 'Resolution']}
              rows={data.checks.map((c) => [
                <RowLink key="c" href={`/conflicts/${c.id}`}>
                  #{c.id}
                </RowLink>,
                fmtDateTime(c.runAt),
                c.resolution ? (
                  <Badge key="r" tone={c.resolution === 'no_conflict_found' ? 'green' : 'amber'}>
                    {c.resolution.replace(/_/g, ' ')}
                  </Badge>
                ) : (
                  'unresolved'
                ),
              ])}
              emptyState={
                <span>
                  No checks attached. <RowLink href={`/conflicts?attach_kind=intake_record&attach_id=${r.id}`}>Run one</RowLink>
                  {' '}— a resolved check attached here satisfies the conversion gate too, once.
                </span>
              }
            />
          </Panel>
        </div>

        <div>
          {open && flags.intakeConvert ? (
            <Panel title="Convert to a matter">
              <p className="mb-3 text-sm text-neutral-500">
                One act: the matter opens with the prospect as client, the title and summary seeded
                from the approach (no retyping), every party carried across, and the two records
                cross-linked. If it refuses, nothing at all happens — no number is consumed.
              </p>
              <form action={convertIntakeAction} className="max-w-md">
                <input type="hidden" name="intake" value={r.id} />
                <Field label="Title" hint="Defaults to the first line of the approach">
                  <TextInput name="title" />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Responsible lawyer">
                    <Select name="responsible_lawyer">
                      {options.lawyers.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Office">
                    <Select name="office">
                      {options.offices.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field label="Practice area" hint="Defaults to the approach's area">
                  <Select name="practice_area" defaultValue={r.practiceArea ?? ''}>
                    <option value="">(use the approach's)</option>
                    {options.areas
                      .filter((a) => a.active)
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </Select>
                </Field>
                <SubmitButton>Convert to matter</SubmitButton>
              </form>
            </Panel>
          ) : null}

          <Panel title="Parties on this approach">
            <DataTable
              headers={['Party', 'Capacity', '']}
              rows={data.parties.map((ip) => [
                <RowLink key="n" href={`/parties/${ip.party}`}>
                  {ip.name}
                </RowLink>,
                ip.capacity,
                open ? (
                  <InlineAction
                    key="rm"
                    action={removeIntakePartyAction}
                    fields={{ intake: r.id, intake_party: ip.id }}
                    label="Remove"
                  />
                ) : (
                  ''
                ),
              ])}
              emptyState="No further parties — the prospect is carried automatically."
            />
            {open ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-sky-700">Add party</summary>
                <form action={addIntakePartyAction} className="mt-3 max-w-xs">
                  <input type="hidden" name="intake" value={r.id} />
                  <Field label="Party #">
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
                  <SubmitButton tone="quiet">Add</SubmitButton>
                </form>
              </details>
            ) : null}
          </Panel>

          <Panel title="Notes">
            {data.notes.length === 0 ? (
              <EmptyState>No notes yet.</EmptyState>
            ) : (
              <ul className="space-y-3">
                {data.notes.map((n) => (
                  <li key={n.id} className="rounded-md border border-neutral-100 bg-neutral-50 p-3 text-sm">
                    <p className="whitespace-pre-wrap text-neutral-800">{n.body}</p>
                    <div className="mt-1 flex items-center justify-between text-xs text-neutral-400">
                      <span>{fmtDateTime(n.notedAt)}</span>
                      {open ? (
                        <InlineAction
                          action={removeIntakeNoteAction}
                          fields={{ intake: r.id, note: n.id }}
                          label="Remove"
                        />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {open ? (
              <form action={addIntakeNoteAction} className="mt-3">
                <input type="hidden" name="intake" value={r.id} />
                <Field label="New note">
                  <TextArea name="body" rows={2} required />
                </Field>
                <SubmitButton tone="quiet">Add note</SubmitButton>
              </form>
            ) : null}
          </Panel>
        </div>
      </div>
    </Page>
  )
}
