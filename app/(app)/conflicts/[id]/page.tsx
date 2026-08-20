// A conflict check's immutable snapshot: grouped results with context, the
// restricted-match line (existence disclosed, detail withheld, whom-to-ask
// per the setting), attach and resolve actions, print via the browser. The
// snapshot never re-resolves — it renders as the day it ran.

import { requirePrincipal } from '@/lib/auth'
import { conflictCheckDetail } from '@/lib/reads/matters'
import { Page, Panel, DataTable, DetailList, Notices, RowLink, Badge, EmptyState, fmtDateTime } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { attachCheckAction, resolveCheckAction } from '../actions'

const GROUP_TITLES: Record<string, string> = {
  party_names: 'People & organisations (every name kind, fuzzy)',
  matters: 'Matters where matched parties appear',
  intakes: 'Approaches involving matched parties',
  past_check_snapshots: 'Names inside past checks',
  text_corpus: 'Registered text (titles, summaries, notes…)',
}

interface Group {
  where: string
  hits: Record<string, unknown>[]
}

function GroupTable({ g }: { g: Group }) {
  if (g.hits.length === 0) return null
  switch (g.where) {
    case 'party_names':
      return (
        <DataTable
          headers={['Party', 'State', 'All names']}
          rows={g.hits.map((h) => [
            <RowLink key="p" href={`/parties/${h.party}`}>
              {String(h.display_name)}
            </RowLink>,
            String(h.state),
            Array.isArray(h.names)
              ? (h.names as { name_kind: string; full_name: string }[])
                  .map((n) => `${n.full_name} (${n.name_kind.replace('_', ' ')})`)
                  .join(' · ')
              : '',
          ])}
        />
      )
    case 'matters':
      return (
        <DataTable
          headers={['Matter', 'Title', 'Status']}
          rows={g.hits.map((h) => [
            <RowLink key="m" href={`/matters/${h.matter}`}>
              {String(h.matter_number)}
            </RowLink>,
            String(h.title),
            String(h.status).replace('_', ' '),
          ])}
        />
      )
    case 'intakes':
      return (
        <DataTable
          headers={['Approach', 'State']}
          rows={g.hits.map((h) => [
            <RowLink key="i" href={`/intake/${h.id}`}>
              #{String(h.id)}
            </RowLink>,
            String(h.state),
          ])}
        />
      )
    case 'past_check_snapshots':
      return (
        <DataTable
          headers={['Check', 'Run']}
          rows={g.hits.map((h) => [
            <RowLink key="c" href={`/conflicts/${h.check}`}>
              #{String(h.check)}
            </RowLink>,
            fmtDateTime(h.run_at),
          ])}
        />
      )
    case 'text_corpus':
      return (
        <DataTable
          headers={['Where', 'Matched text', 'Matter']}
          rows={g.hits.map((h, i) => [
            `${String(h.source_module)} ${String(h.source_type).replace(/_/g, ' ')}`,
            <span key={`t${i}`} className="text-neutral-600">
              …{String(h.context)}…
            </span>,
            h.matter ? (
              <RowLink key="m" href={`/matters/${h.matter}`}>
                #{String(h.matter)}
              </RowLink>
            ) : (
              '—'
            ),
          ])}
        />
      )
    default:
      return (
        <DataTable headers={['Hit']} rows={g.hits.map((h, i) => [<span key={i}>{JSON.stringify(h)}</span>])} />
      )
  }
}

export default async function ConflictCheckPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const check = await conflictCheckDetail(p, Number(id))
  const snapshot = check.snapshot as {
    groups: Group[]
    restricted_matches?: { count: number; contact: string }
  }
  const totalHits = snapshot.groups.reduce((n, g) => n + g.hits.length, 0)
  const restricted = snapshot.restricted_matches?.count ?? 0

  return (
    <Page
      title={`Conflict check #${check.id}`}
      lead={`Searched “${(check.terms as { name?: string })?.name ?? ''}” — run ${fmtDateTime(check.runAt)} by ${check.runnerName}. This snapshot is permanent evidence and never changes.`}
    >
      <Notices searchParams={sp} />

      {totalHits === 0 && restricted === 0 ? (
        <Panel>
          <EmptyState>No matches found — record the resolution below.</EmptyState>
        </Panel>
      ) : (
        snapshot.groups.map((g) =>
          g.hits.length > 0 ? (
            <Panel key={g.where} title={`${GROUP_TITLES[g.where] ?? g.where} (${g.hits.length})`}>
              <GroupTable g={g} />
            </Panel>
          ) : null,
        )
      )}

      {restricted > 0 ? (
        <Panel title="Restricted matches">
          <p className="text-sm text-neutral-800">
            <Badge tone="violet">{restricted} match(es) inside restricted matters</Badge>{' '}
            <span className="text-neutral-600">
              — they exist, their detail is withheld. Ask: <strong>{snapshot.restricted_matches?.contact}</strong>.
              A restriction can never silently hide a conflict.
            </span>
          </p>
        </Panel>
      ) : null}

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <Panel title="Attachment">
          {check.attachedToKind !== 'none' ? (
            <DetailList
              items={[
                [
                  'Attached to',
                  check.attachedToKind === 'matter' ? (
                    <RowLink key="a" href={`/matters/${check.attachedTo}`}>
                      matter #{check.attachedTo}
                    </RowLink>
                  ) : (
                    <RowLink key="a" href={`/intake/${check.attachedTo}`}>
                      approach #{check.attachedTo}
                    </RowLink>
                  ),
                ],
              ]}
            />
          ) : (
            <form action={attachCheckAction} className="flex max-w-md items-end gap-2">
              <input type="hidden" name="check" value={check.id} />
              <div className="w-40">
                <Field label="Attach to">
                  <Select name="attach_kind" defaultValue={sp.attach_kind ?? 'matter'}>
                    <option value="matter">Matter</option>
                    <option value="intake_record">Approach</option>
                  </Select>
                </Field>
              </div>
              <div className="w-28">
                <Field label="#">
                  <TextInput name="attach_id" required inputMode="numeric" defaultValue={sp.attach_id ?? ''} />
                </Field>
              </div>
              <div className="pb-3">
                <SubmitButton tone="quiet">Attach</SubmitButton>
              </div>
            </form>
          )}
        </Panel>

        <Panel title="Resolution">
          {check.resolution ? (
            <DetailList
              items={[
                [
                  'Resolution',
                  <Badge key="r" tone={check.resolution === 'no_conflict_found' ? 'green' : 'amber'}>
                    {check.resolution.replace(/_/g, ' ')}
                  </Badge>,
                ],
                ['Action taken', check.actionNote ?? '—'],
                ['By', `${check.resolverName}, ${fmtDateTime(check.resolvedAt)}`],
              ]}
            />
          ) : (
            <form action={resolveCheckAction} className="max-w-md">
              <input type="hidden" name="check" value={check.id} />
              <Field label="Finding">
                <Select name="resolution" defaultValue="no_conflict_found">
                  <option value="no_conflict_found">No conflict found</option>
                  <option value="conflict_found_action_taken">Conflict found — action taken</option>
                </Select>
              </Field>
              <Field label="Action taken" hint="Required when a conflict was found">
                <TextInput name="action_note" />
              </Field>
              <SubmitButton tone="quiet">Record resolution</SubmitButton>
            </form>
          )}
        </Panel>
      </div>
    </Page>
  )
}
