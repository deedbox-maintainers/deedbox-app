// Billing runs: preview the candidate matters under the filters — client
// name, unbilled value at the cut-off, held client money — choose exactly
// which matters to bill, then build. Matters on hold or closed are shown
// with the reason and cannot be ticked; the run records every exclusion.

import { requirePrincipal } from '@/lib/auth'
import { billingRuns, billingRunCandidates } from '@/lib/reads/billing'
import { matterFilterOptions } from '@/lib/reads/matters'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDateTime } from '@/components/ui'
import { Field, Select, TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { createRunAction } from '../actions'

export default async function BillingRunsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const [runs, options] = await Promise.all([billingRuns(p), matterFilterOptions(p)])
  const previewing = sp.preview === '1'
  const filters = {
    practiceArea: sp.practice_area ? Number(sp.practice_area) : undefined,
    office: sp.office ? Number(sp.office) : undefined,
    responsibleLawyer: sp.lawyer ? Number(sp.lawyer) : undefined,
    throughDate: sp.through_date || undefined,
  }
  const candidates = previewing ? await billingRunCandidates(p, filters) : []
  const billable = candidates.filter((c) => c.billable)

  return (
    <Page
      title="Billing runs"
      lead="Preview every matter with unbilled work, choose exactly which to bill, then build the run — matters on hold, closed, or with nothing to bill are excluded with the reason itemised, never silently."
    >
      <Notices searchParams={sp} />
      <Panel title="Start a run — step 1: preview the matters">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="preview" value="1" />
          <div className="w-44">
            <Field label="Practice area" hint="Optional filter">
              <Select name="practice_area" defaultValue={sp.practice_area ?? ''}>
                <option value="">All</option>
                {options.areas
                  .filter((a) => a.active)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <div className="w-40">
            <Field label="Office">
              <Select name="office" defaultValue={sp.office ?? ''}>
                <option value="">All</option>
                {options.offices.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-44">
            <Field label="Responsible lawyer">
              <Select name="lawyer" defaultValue={sp.lawyer ?? ''}>
                <option value="">All</option>
                {options.lawyers.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-44">
            <Field label="Work dated on or before" hint="Blank = everything unbilled">
              <TextInput name="through_date" type="date" defaultValue={sp.through_date ?? ''} />
            </Field>
          </div>
          <div className="pb-3">
            <SubmitButton>Preview the matters</SubmitButton>
          </div>
        </form>
      </Panel>

      {previewing ? (
        <Panel title={`Step 2: choose what to bill (${billable.length} billable of ${candidates.length} matched)`}>
          {candidates.length === 0 ? (
            <p className="text-sm text-neutral-500">No matter under these filters has unbilled work.</p>
          ) : (
            <form action={createRunAction}>
              <input type="hidden" name="practice_area" value={sp.practice_area ?? ''} />
              <input type="hidden" name="office" value={sp.office ?? ''} />
              <input type="hidden" name="lawyer" value={sp.lawyer ?? ''} />
              <input type="hidden" name="through_date" value={sp.through_date ?? ''} />
              <input type="hidden" name="selected" value="1" />
              <DataTable
                headers={['Bill?', 'Matter', 'Client', 'Unbilled', 'Held money available', '']}
                rows={candidates.map((c) => [
                  c.billable ? (
                    <input
                      key="t"
                      type="checkbox"
                      name="m"
                      value={c.id}
                      defaultChecked
                      className="h-4 w-4"
                      aria-label={`Bill ${c.matterNumber}`}
                    />
                  ) : (
                    ''
                  ),
                  <RowLink key="m" href={`/matters/${c.id}`}>
                    {c.matterNumber} — {c.title}
                  </RowLink>,
                  c.clientName || '—',
                  <span key="u" className="tabular-nums">{c.unbilledValue.toFixed(2)}</span>,
                  <span key="h" className="tabular-nums">{c.heldAvailable.toFixed(2)}</span>,
                  c.whyNot ? <Badge key="w" tone="amber">{c.whyNot}</Badge> : '',
                ])}
              />
              <div className="mt-3 flex items-center gap-3">
                <SubmitButton>Build the run with the ticked matters (drafts only — nothing issues yet)</SubmitButton>
              </div>
              <p className="mt-2 text-xs text-neutral-400">
                Untick a matter to leave it for another day. Held money is applied on the run's own screen
                after the bills issue — nothing moves at this step.
              </p>
            </form>
          )}
        </Panel>
      ) : null}

      <Panel title="Runs">
        <DataTable
          headers={['Run', 'When', 'By', 'Drafted', 'State']}
          rows={runs.map((r) => [
            <RowLink key="r" href={`/billing/runs/${r.id}`}>
              #{String(r.id)}
            </RowLink>,
            fmtDateTime(r.run_at),
            String((r.run_by_name as { family?: string })?.family ?? ''),
            String(r.groups),
            <Badge key="s" tone={r.state === 'issued' ? 'green' : r.state === 'abandoned' ? 'neutral' : 'blue'}>
              {String(r.state).replace('_', ' ')}
            </Badge>,
          ])}
          emptyState="Start a run."
        />
      </Panel>
    </Page>
  )
}
