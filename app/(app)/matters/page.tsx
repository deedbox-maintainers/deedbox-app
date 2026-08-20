// Matter list: filters, per-row financials from the display cache, and
// the multi-select actions riding the bulk machinery with a dry-run first.
// Restricted matters the viewer cannot see are simply absent — never greyed.

import Link from 'next/link'
import { requirePrincipal } from '@/lib/auth'
import { matterList, matterFilterOptions } from '@/lib/reads/matters'
import { Page, Panel, Notices, RowLink, Badge, EmptyState } from '@/components/ui'
import { TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { bulkPrepareAction } from './actions'

const STATUS_TONES: Record<string, 'green' | 'amber' | 'neutral'> = {
  open: 'green',
  on_hold: 'amber',
  closed: 'neutral',
  archived: 'neutral',
}

function money(v: number | null): string {
  return v === null ? '—' : v.toFixed(2)
}

export default async function MattersPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const filters = {
    status: sp.status || undefined,
    office: sp.office ? Number(sp.office) : undefined,
    practiceArea: sp.area ? Number(sp.area) : undefined,
    lawyer: sp.lawyer ? Number(sp.lawyer) : undefined,
    q: sp.q || undefined,
  }
  const [rows, options] = await Promise.all([matterList(p, filters), matterFilterOptions(p)])

  return (
    <Page
      title="Matters"
      lead="Every matter you can see. Figures are the working position (unbilled · outstanding · held available) — each opens its records."
      actions={
        <Link
          href="/matters/new"
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
        >
          New matter
        </Link>
      }
    >
      <Notices searchParams={sp} />
      <Panel>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3 text-sm">
          <div className="w-44">
            <TextInput name="q" defaultValue={sp.q ?? ''} placeholder="Number or title…" />
          </div>
          <Select name="status" defaultValue={sp.status ?? ''} className="w-32">
            <option value="">Any status</option>
            <option value="open">Open</option>
            <option value="on_hold">On hold</option>
            <option value="closed">Closed</option>
            <option value="archived">Archived</option>
          </Select>
          <Select name="office" defaultValue={sp.office ?? ''} className="w-36">
            <option value="">Any office</option>
            {options.offices.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
          <Select name="area" defaultValue={sp.area ?? ''} className="w-40">
            <option value="">Any practice area</option>
            {options.areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Select name="lawyer" defaultValue={sp.lawyer ?? ''} className="w-40">
            <option value="">Any lawyer</option>
            {options.lawyers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
          <SubmitButton tone="quiet">Filter</SubmitButton>
        </form>

        {rows.length === 0 ? (
          <EmptyState>No matters match.</EmptyState>
        ) : (
          <form action={bulkPrepareAction}>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left">
                    <th className="w-8 px-2 py-1.5" />
                    <th className="px-2 py-1.5 font-medium text-neutral-500">Matter</th>
                    <th className="px-2 py-1.5 font-medium text-neutral-500">Title</th>
                    <th className="px-2 py-1.5 font-medium text-neutral-500">Client</th>
                    <th className="px-2 py-1.5 font-medium text-neutral-500">Lawyer</th>
                    <th className="px-2 py-1.5 font-medium text-neutral-500">Area</th>
                    <th className="px-2 py-1.5 font-medium text-neutral-500">Status</th>
                    <th className="px-2 py-1.5 text-right font-medium text-neutral-500">Unbilled</th>
                    <th className="px-2 py-1.5 text-right font-medium text-neutral-500">Outstanding</th>
                    <th className="px-2 py-1.5 text-right font-medium text-neutral-500">Held avail.</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.id} className="border-b border-neutral-100 align-top hover:bg-neutral-50">
                      <td className="px-2 py-1.5">
                        <input type="checkbox" name="matters" value={m.id} className="h-4 w-4" />
                      </td>
                      <td className="px-2 py-1.5">
                        <RowLink href={`/matters/${m.id}`}>{m.matterNumber}</RowLink>
                        {m.restricted ? (
                          <span className="ml-1">
                            <Badge tone="violet">restricted</Badge>
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2 py-1.5 text-neutral-800">{m.title}</td>
                      <td className="px-2 py-1.5 text-neutral-800">{m.clientName}</td>
                      <td className="px-2 py-1.5 text-neutral-800">{m.lawyerName}</td>
                      <td className="px-2 py-1.5 text-neutral-800">{m.areaName}</td>
                      <td className="px-2 py-1.5">
                        <Badge tone={STATUS_TONES[m.status] ?? 'neutral'}>{m.status.replace('_', ' ')}</Badge>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{money(m.unbilled)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{money(m.outstanding)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{money(m.heldAvailable)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center gap-2 border-t border-neutral-100 pt-3 text-sm">
              <span className="text-neutral-500">With the ticked matters:</span>
              <Select name="kind" className="w-40" defaultValue="matter_hold">
                <option value="matter_close">Close</option>
                <option value="matter_reopen">Reopen</option>
                <option value="matter_hold">Put on hold</option>
                <option value="matter_resume">Resume</option>
              </Select>
              <SubmitButton tone="quiet">Preview (nothing happens yet)</SubmitButton>
            </div>
          </form>
        )}
      </Panel>
    </Page>
  )
}
