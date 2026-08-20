// The examination workspace shell: examiner principals only — staff are
// sent to their own shell, and the badge names the access window and the
// examined period on every screen. Navigation is the fixed examiner surface
// set; there is nothing else to see.

import type { ReactNode } from 'react'
import { readBrand } from '@/lib/brand'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requirePrincipal, signOutCookieSession } from '@/lib/auth'
import { examinerContext } from '@/lib/reads/examiner'
import { fmtDate, fmtDateTime } from '@/components/ui'

const NAV: { href: string; label: string }[] = [
  { href: '/examiner', label: 'Overview & cash books' },
  { href: '/examiner/ledgers', label: 'Ledgers' },
  { href: '/examiner/recons', label: 'Reconciliations' },
  { href: '/examiner/transfers', label: 'Transfer journal' },
  { href: '/examiner/refusals', label: 'Refusal register' },
  { href: '/examiner/incidents', label: 'Incident register' },
  { href: '/examiner/master-data', label: 'Master-data journal' },
]

async function signOut(): Promise<void> {
  'use server'
  await signOutCookieSession()
  redirect('/examiner/sign-in')
}

export default async function ExaminerLayout({ children }: { children: ReactNode }) {
  const principal = await requirePrincipal()
  if (principal.kind !== 'examiner') redirect('/')
  const ctx = await examinerContext(principal)
  const brand = await readBrand()
  return (
    <div className="flex min-h-screen bg-neutral-50">
      <aside className="w-56 shrink-0 border-r border-neutral-200 bg-white">
        <div className="px-4 py-4">
          <Link href="/examiner" className="text-base font-semibold text-neutral-900">
            {brand.name}
          </Link>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            Examination
          </p>
        </div>
        <nav className="px-2 pb-6">
          {NAV.map((i) => (
            <Link
              key={i.href}
              href={i.href}
              className="block rounded px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-100"
            >
              {i.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-neutral-200 px-4 py-3 text-[11px] leading-4 text-neutral-500">
          <p className="font-medium text-neutral-600">{ctx.examinerName}</p>
          <p>
            Examined period {fmtDate(ctx.periodStart)} – {fmtDate(ctx.periodEnd)}
          </p>
          <p>Access until {fmtDateTime(ctx.expiresAt)}</p>
          <p className="mt-1">Read-only; every read is recorded.</p>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-end gap-3 border-b border-neutral-200 bg-white px-6 py-2">
          <span className="text-sm text-neutral-600">{ctx.examinerName}</span>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-50"
            >
              Sign out
            </button>
          </form>
        </header>
        {children}
      </div>
    </div>
  )
}
