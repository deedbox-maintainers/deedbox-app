// Intake: the counts tiles, then a board when active stages exist (flat
// list otherwise), filters, and the stage administration for
// lists.manage holders. Test-mode records never appear here.

import Link from 'next/link'
import { requirePrincipal } from '@/lib/auth'
import { intakeBoard, intakeTiles, matterFilterOptions, mattersViewerFlags } from '@/lib/reads/matters'
import { Page, Panel, DataTable, Notices, RowLink, Badge, EmptyState } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { addStageAction, renameStageAction, setStageActiveAction, reorderStagesAction } from './actions'

export default async function IntakePage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const [board, tiles, options, flags] = await Promise.all([
    intakeBoard(p, {
      state: sp.state || undefined,
      practiceArea: sp.area ? Number(sp.area) : undefined,
      outcome: sp.outcome ? Number(sp.outcome) : undefined,
    }),
    intakeTiles(p),
    matterFilterOptions(p),
    mattersViewerFlags(p),
  ])
  const activeStages = board.stages.filter((s) => s.active)
  const hasBoard = activeStages.length > 0

  if (!board.enabled) {
    return (
      <Page title="Intake" lead="New approaches before they become matters.">
        <Notices searchParams={sp} />
        <Panel>
          <EmptyState>
            Intake is switched off{flags.lists ? ' — turn it on under Firm settings (intake.enabled)' : ''}.
          </EmptyState>
        </Panel>
      </Page>
    )
  }

  return (
    <Page
      title="Intake"
      lead="New approaches — recorded, staged if the firm uses stages, and converted to matters without retyping."
      actions={
        <Link
          href="/intake/new"
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Record approach
        </Link>
      }
    >
      <Notices searchParams={sp} />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.perStage.map((t) => (
          <div key={t.stage_name} className="rounded-md border border-neutral-200 bg-white p-3 text-center">
            <p className="text-xs text-neutral-500">{t.stage_name}</p>
            <p className="text-xl font-semibold">{t.n}</p>
          </div>
        ))}
        {tiles.perStage.length === 0 ? (
          <div className="rounded-md border border-neutral-200 bg-white p-3 text-center">
            <p className="text-xs text-neutral-500">Open approaches</p>
            <p className="text-xl font-semibold">0</p>
          </div>
        ) : null}
        <div className="rounded-md border border-neutral-200 bg-white p-3">
          <p className="mb-1 text-xs text-neutral-500">Outcomes, last {tiles.periodDays} days</p>
          {tiles.outcomes.length === 0 ? (
            <p className="text-sm text-neutral-400">None recorded</p>
          ) : (
            tiles.outcomes.map((o) => (
              <p key={o.outcome} className="text-sm">
                {o.outcome}: <span className="font-medium">{o.n}</span>
              </p>
            ))
          )}
        </div>
      </div>

      <Panel>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3 text-sm">
          <Select name="state" defaultValue={sp.state ?? ''} className="w-36">
            <option value="">Any state</option>
            <option value="open">Open</option>
            <option value="converted">Converted</option>
            <option value="closed">Closed</option>
          </Select>
          <Select name="area" defaultValue={sp.area ?? ''} className="w-40">
            <option value="">Any practice area</option>
            {options.areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Select name="outcome" defaultValue={sp.outcome ?? ''} className="w-40">
            <option value="">Any outcome</option>
            {options.intakeOutcomes.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
          <SubmitButton tone="quiet">Filter</SubmitButton>
        </form>

        {board.records.length === 0 ? (
          <EmptyState>No approaches recorded.</EmptyState>
        ) : hasBoard && !sp.state ? (
          <div className="flex gap-4 overflow-x-auto pb-2">
            {activeStages.map((stage) => {
              const cards = board.records.filter((r) => r.stage === stage.id && r.state === 'open')
              return (
                <div key={stage.id} className="w-64 shrink-0">
                  <p className="mb-2 text-sm font-medium text-neutral-700">
                    {stage.name} <span className="text-neutral-400">({cards.length})</span>
                  </p>
                  <div className="space-y-2">
                    {cards.map((r) => (
                      <Link
                        key={r.id}
                        href={`/intake/${r.id}`}
                        className="block rounded-md border border-neutral-200 bg-white p-3 text-sm hover:border-sky-300"
                      >
                        <p className="font-medium text-neutral-800">{r.prospectName}</p>
                        <p className="line-clamp-2 text-neutral-500">{r.about}</p>
                        {r.areaName ? <p className="mt-1 text-xs text-neutral-400">{r.areaName}</p> : null}
                      </Link>
                    ))}
                    {cards.length === 0 ? (
                      <p className="rounded-md border border-dashed border-neutral-200 p-3 text-center text-xs text-neutral-400">
                        Empty
                      </p>
                    ) : null}
                  </div>
                </div>
              )
            })}
            {board.records.filter((r) => r.state === 'open' && !activeStages.some((s) => s.id === r.stage)).length >
            0 ? (
              <div className="w-64 shrink-0">
                <p className="mb-2 text-sm font-medium text-neutral-400">No stage / retired stage</p>
                <div className="space-y-2">
                  {board.records
                    .filter((r) => r.state === 'open' && !activeStages.some((s) => s.id === r.stage))
                    .map((r) => (
                      <Link
                        key={r.id}
                        href={`/intake/${r.id}`}
                        className="block rounded-md border border-neutral-200 bg-white p-3 text-sm hover:border-sky-300"
                      >
                        <p className="font-medium text-neutral-800">{r.prospectName}</p>
                        <p className="line-clamp-2 text-neutral-500">{r.about}</p>
                        {r.stageName ? (
                          <p className="mt-1 text-xs text-neutral-300 line-through">{r.stageName}</p>
                        ) : null}
                      </Link>
                    ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <DataTable
            headers={['Prospect', 'About', 'Stage', 'Area', 'State', 'Outcome']}
            rows={board.records.map((r) => [
              <RowLink key="l" href={`/intake/${r.id}`}>
                {r.prospectName}
              </RowLink>,
              <span key="a" className="text-neutral-600">
                {r.about.length > 80 ? `${r.about.slice(0, 80)}…` : r.about}
              </span>,
              r.stageName ? (
                <span key="st" className={r.stageActive === false ? 'text-neutral-400 line-through' : ''}>
                  {r.stageName}
                </span>
              ) : (
                '—'
              ),
              r.areaName ?? '—',
              r.state === 'converted' ? (
                <RowLink key="cv" href={`/matters/${r.convertedMatter}`}>
                  <Badge tone="green">converted → {r.convertedNumber}</Badge>
                </RowLink>
              ) : (
                <Badge key="s" tone={r.state === 'open' ? 'blue' : 'neutral'}>
                  {r.state}
                </Badge>
              ),
              r.outcomeLabel ?? '—',
            ])}
          />
        )}
      </Panel>

      {flags.lists ? (
        <Panel title="Stages (board columns)">
          <DataTable
            headers={['Order', 'Stage', 'State', '', '']}
            rows={board.stages.map((s) => [
              s.active ? String(s.position) : '—',
              s.name,
              s.active ? <Badge key="a" tone="green">active</Badge> : <Badge key="a">retired</Badge>,
              <form key="rn" action={renameStageAction} className="flex items-center gap-1">
                <input type="hidden" name="stage" value={s.id} />
                <TextInput name="name" defaultValue={s.name} className="!w-40" />
                <SubmitButton tone="quiet">Rename</SubmitButton>
              </form>,
              <InlineAction
                key="tg"
                action={setStageActiveAction}
                fields={{ stage: s.id, active: s.active ? '' : 'on' }}
                label={s.active ? 'Retire' : 'Reactivate'}
              />,
            ])}
            emptyState="No stages — approaches show as a flat list. Add the first stage to get a board."
          />
          <div className="mt-3 flex flex-wrap items-end gap-6">
            <form action={addStageAction} className="flex items-end gap-2">
              <div className="w-56">
                <Field label="New stage">
                  <TextInput name="name" required />
                </Field>
              </div>
              <div className="pb-3">
                <SubmitButton tone="quiet">Add</SubmitButton>
              </div>
            </form>
            {activeStages.length > 1 ? (
              <form action={reorderStagesAction} className="flex items-end gap-2">
                <div className="w-72">
                  <Field
                    label="Reorder (stage numbers, first to last)"
                    hint={`Current: ${activeStages.map((s) => s.id).join(',')}`}
                  >
                    <TextInput name="ordered" defaultValue={activeStages.map((s) => s.id).join(',')} />
                  </Field>
                </div>
                <div className="pb-3">
                  <SubmitButton tone="quiet">Reorder</SubmitButton>
                </div>
              </form>
            ) : null}
          </div>
        </Panel>
      ) : null}
    </Page>
  )
}
