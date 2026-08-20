// The suggestion queue: your pending and held suggestions from activity
// signals. Acceptance is the ONLY exit that creates a time entry; held rows
// prompt matter assignment first; discarding needs a matter on record.

import { requirePrincipal } from '@/lib/auth'
import { suggestionQueue } from '@/lib/reads/billing'
import { Page, Panel, Notices, RowLink, Badge, EmptyState, fmtDate } from '@/components/ui'
import { TextInput, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  assignSuggestionAction,
  acceptSuggestionAction,
  mergeSuggestionAction,
  discardSuggestionAction,
} from '../actions'

export default async function SuggestionsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const rows = await suggestionQueue(p)

  return (
    <Page
      title="Suggested time"
      lead="Work the system noticed — emails, documents, appointments — waiting for your decision. Accepting records the time; nothing enters the books without you."
    >
      <Notices searchParams={sp} />
      <Panel>
        {rows.length === 0 ? (
          <EmptyState>Nothing awaiting review.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {rows.map((s) => (
              <li key={s.id as number} className="rounded-md border border-neutral-200 p-3 text-sm">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge tone={s.state === 'pending' ? 'blue' : 'amber'}>
                    {s.state === 'pending' ? 'ready' : 'needs a matter'}
                  </Badge>
                  <span className="text-neutral-500">
                    {fmtDate(s.proposed_date)} · {String(s.proposed_minutes)} min ·{' '}
                    {String(s.signal_kind).replace(/_/g, ' ')} from {String(s.signal_source)}
                  </span>
                  {s.matter_number ? (
                    <RowLink href={`/matters/${s.matter}/billing`}>{String(s.matter_number)}</RowLink>
                  ) : null}
                </div>
                <p className="mb-2 text-neutral-800">{String(s.proposed_narrative)}</p>
                <div className="flex flex-wrap items-end gap-4">
                  {s.state === 'held_unmatched' ? (
                    <form action={assignSuggestionAction} className="flex items-center gap-2">
                      <input type="hidden" name="suggestion" value={s.id as number} />
                      <TextInput name="matter" placeholder="Matter #" inputMode="numeric" className="!w-28" />
                      <SubmitButton tone="quiet">Assign matter</SubmitButton>
                    </form>
                  ) : (
                    <>
                      <form action={acceptSuggestionAction} className="flex items-center gap-2">
                        <input type="hidden" name="suggestion" value={s.id as number} />
                        <TextInput name="units" placeholder="Units (edit)" inputMode="numeric" className="!w-28" />
                        <TextInput name="narrative" placeholder="Narrative (edit)" className="!w-64" />
                        <SubmitButton>Accept</SubmitButton>
                      </form>
                      <form action={mergeSuggestionAction} className="flex items-center gap-2">
                        <input type="hidden" name="suggestion" value={s.id as number} />
                        <TextInput name="into_entry" placeholder="Merge into entry #" inputMode="numeric" className="!w-36" />
                        <SubmitButton tone="quiet">Merge</SubmitButton>
                      </form>
                      <InlineAction
                        action={discardSuggestionAction}
                        fields={{ suggestion: s.id as number }}
                        label="Discard"
                      />
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Page>
  )
}
