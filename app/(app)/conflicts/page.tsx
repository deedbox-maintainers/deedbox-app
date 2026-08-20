// Conflict check screen: terms + options. The run writes the immutable
// snapshot and lands on it. Coverage: every name a party has ever carried,
// matter/intake appearances, names inside past checks' snapshots, and the
// registered text corpus — with a restricted-match pinhole that can never
// silently hide a conflict.

import { requirePrincipal } from '@/lib/auth'
import { conflictRegister } from '@/lib/reads/matters'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDateTime } from '@/components/ui'
import { Field, TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { runCheckAction } from './actions'

export default async function ConflictsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const recent = await conflictRegister(p, { limit: 15 })

  return (
    <Page
      title="Conflict check"
      lead="Searches every name the firm has ever recorded — current, former, trading, parties on matters and approaches, names inside past checks, and registered text — with fuzzy matching for misspellings. The results are snapshotted permanently."
    >
      <Notices searchParams={sp} />

      <Panel title="Run a check">
        <form action={runCheckAction} className="max-w-lg">
          {sp.attach_kind && sp.attach_id ? (
            <>
              <input type="hidden" name="attach_kind" value={sp.attach_kind} />
              <input type="hidden" name="attach_id" value={sp.attach_id} />
              <p className="mb-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
                The finished check will offer to attach to {sp.attach_kind.replace('_', ' ')} #
                {sp.attach_id}.
              </p>
            </>
          ) : null}
          <Field label="Name to search">
            <TextInput name="name" required placeholder="Person or organisation" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone" hint="Optional — tightens matching">
              <TextInput name="phone" />
            </Field>
            <Field label="Email" hint="Optional">
              <TextInput name="email" />
            </Field>
          </div>
          <SubmitButton>Run check</SubmitButton>
        </form>
      </Panel>

      <Panel
        title="Recent checks"
        actions={<RowLink href="/conflicts/register">Full register</RowLink>}
      >
        <DataTable
          headers={['Check', 'Searched', 'By', 'When', 'Attached', 'Resolution']}
          rows={recent.map((c) => [
            <RowLink key="c" href={`/conflicts/${c.id}`}>
              #{c.id}
            </RowLink>,
            c.terms?.name ?? '—',
            c.runnerName,
            fmtDateTime(c.runAt),
            c.attachedToKind === 'none' ? (
              '—'
            ) : c.attachedToKind === 'matter' ? (
              <RowLink key="a" href={`/matters/${c.attachedTo}`}>
                {c.attachedMatterNumber ?? `matter #${c.attachedTo}`}
              </RowLink>
            ) : (
              <RowLink key="a" href={`/intake/${c.attachedTo}`}>
                approach #{c.attachedTo}
              </RowLink>
            ),
            c.resolution ? (
              <Badge key="r" tone={c.resolution === 'no_conflict_found' ? 'green' : 'amber'}>
                {c.resolution.replace(/_/g, ' ')}
              </Badge>
            ) : (
              'unresolved'
            ),
          ])}
          emptyState="No checks yet."
        />
      </Panel>
    </Page>
  )
}
