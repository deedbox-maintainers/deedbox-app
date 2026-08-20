// The shared presentational kit. Server-component-safe: no state, no
// effects — structure and Tailwind classes only. Screens stay thin; these
// keep them consistent (the empty-state and every-list-opens-its-rows
// disciplines are conventions of use, enforced by the screens themselves).

import type { ReactNode } from 'react'
import Link from 'next/link'
import { DISPLAY_LOCALE } from '@/lib/format'

export function Page({
  title,
  lead,
  actions,
  children,
}: {
  title: string
  lead?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">{title}</h1>
          {lead ? <p className="mt-1 max-w-3xl text-sm text-neutral-500">{lead}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  )
}

export function Panel({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={`mb-6 rounded-lg border border-neutral-200 bg-white ${className ?? ''}`}
    >
      {title !== undefined || actions !== undefined ? (
        <header className="flex items-center justify-between gap-3 border-b border-neutral-100 px-4 py-2.5">
          <h2 className="text-sm font-medium text-neutral-700">{title}</h2>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-neutral-200 bg-neutral-50 px-4 py-6 text-center text-sm text-neutral-500">
      {children}
    </p>
  )
}

export function DataTable({
  headers,
  rows,
  emptyState,
}: {
  headers: ReactNode[]
  rows: ReactNode[][]
  emptyState?: ReactNode
}) {
  if (rows.length === 0 && emptyState) return <EmptyState>{emptyState}</EmptyState>
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-left">
            {headers.map((h, i) => (
              <th key={i} className="px-2 py-1.5 font-medium text-neutral-500">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, ri) => (
            <tr key={ri} className="border-b border-neutral-100 align-top hover:bg-neutral-50">
              {cells.map((c, ci) => (
                <td key={ci} className="px-2 py-1.5 text-neutral-800">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'violet'
  children: ReactNode
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-neutral-100 text-neutral-600',
    green: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    red: 'bg-red-50 text-red-700',
    blue: 'bg-sky-50 text-sky-700',
    violet: 'bg-violet-50 text-violet-700',
  }
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  )
}

/** Post-action notices carried in the query string by the action helper. */
export function Notices({
  searchParams,
}: {
  searchParams: { done?: string; refused?: string }
}) {
  return (
    <>
      {searchParams.done ? (
        <p className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {searchParams.done}
        </p>
      ) : null}
      {searchParams.refused ? (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {searchParams.refused}
        </p>
      ) : null}
    </>
  )
}

export function DetailList({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-neutral-500">{k}</dt>
          <dd className="text-neutral-800">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function RowLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-sky-700 underline-offset-2 hover:underline">
      {children}
    </Link>
  )
}

export function fmtDateTime(v: unknown): string {
  if (!v) return '—'
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(DISPLAY_LOCALE, { hour12: false })
}

export function fmtDate(v: unknown): string {
  if (!v) return '—'
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(DISPLAY_LOCALE)
}

export function fmtJson(v: unknown): string {
  if (v === null || v === undefined) return '—'
  return typeof v === 'string' ? v : JSON.stringify(v)
}

export function personName(v: unknown): string {
  const p = v as { display?: string; given?: string; family?: string } | null
  if (!p) return '—'
  return p.display ?? [p.given, p.family].filter(Boolean).join(' ')
}
