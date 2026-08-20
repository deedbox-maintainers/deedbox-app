// The close board: pack-calendar obligations where declared (with
// permanent late flags), and the on-demand close available at any time.

import { requirePrincipal } from '@/lib/auth'
import { closeBoard } from '@/lib/reads/money'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDate } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { openCloseAction } from '../actions'

const STATUS_TONES: Record<string, 'amber' | 'blue' | 'green'> = {
  due: 'amber',
  in_progress: 'blue',
  certified: 'green',
}

export default async function ClosePage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const b = await closeBoard(p)

  return (
    <Page
      title="Period closes"
      lead="A close certifies the books for a period: every ledger listed, the total proven against the bank position, and the period locked against back-dated postings — permanently."
    >
      <Notices searchParams={sp} />
      <Panel title="Obligations & closes">
        <DataTable
          headers={['Period', 'Scope', 'Due by', 'Status', '']}
          rows={b.closes.map((c) => [
            `${fmtDate(c.period_start)} – ${fmtDate(c.period_end)}`,
            c.account ? String(c.account_name) : 'all accounts',
            c.due_by ? fmtDate(c.due_by) : '—',
            <span key="s">
              <Badge tone={STATUS_TONES[String(c.status)] ?? 'neutral'}>
                {String(c.status).replace('_', ' ')}
              </Badge>
              {c.late ? <Badge tone="red"> certified late — permanent flag</Badge> : null}
            </span>,
            c.status === 'due' ? (
              <InlineAction
                key="open"
                action={openCloseAction}
                fields={{ obligation: c.id as number }}
                label="Open"
              />
            ) : (
              <RowLink key="v" href={`/money/close/${c.id}`}>
                Open the workspace
              </RowLink>
            ),
          ])}
          emptyState="No close obligations due — a close can be run on demand at any time."
        />
      </Panel>
      <Panel title="On-demand close">
        <form action={openCloseAction} className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <Field label="Period start">
              <TextInput name="period_start" type="date" required />
            </Field>
          </div>
          <div className="w-40">
            <Field label="Period end">
              <TextInput name="period_end" type="date" required />
            </Field>
          </div>
          <div className="w-48">
            <Field label="Account" hint="Blank = all accounts">
              <Select name="account" defaultValue="">
                <option value="">All accounts</option>
                {b.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="pb-3">
            <SubmitButton>Open a close</SubmitButton>
          </div>
        </form>
        <p className="mt-1 text-xs text-neutral-400">An on-demand close can never be late.</p>
      </Panel>
    </Page>
  )
}
