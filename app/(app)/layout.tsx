// The authenticated shell. The principal is resolved fresh on every request
// (no cached authority); navigation is filtered by the viewer's capability
// set as display-only convenience, with every screen and operation
// re-checking for itself.

import type { ReactNode } from 'react'
import { readBrand } from '@/lib/brand'
import Link from 'next/link'
import { requirePrincipal, viewerContext, signOutCookieSession } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { withPrincipal } from '@/lib/db'
import { settingText } from '@/lib/ops/shared'
import { parseFirmNavLinks, mergeNavGroups, type NavGroup } from '@/lib/navLinks'

const NAV: NavGroup[] = [
  {
    section: 'Work',
    items: [
      { href: '/', label: 'Home' },
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/search', label: 'Search' },
      { href: '/help', label: 'Help' },
      { href: '/tasks', label: 'My tasks' },
      { href: '/dates', label: 'Critical dates' },
      { href: '/proposals', label: 'Awaiting confirmation' },
      { href: '/matters', label: 'Matters' },
      { href: '/parties', label: 'People & organisations' },
      { href: '/intake', label: 'Intake' },
      { href: '/conflicts', label: 'Conflict checks', caps: ['conflict.run'] },
      { href: '/matters/approvals', label: 'Close approvals', caps: ['matter.close'] },
      { href: '/parties/review', label: 'Duplicate review' },
    ],
  },
  {
    section: 'Client money',
    items: [
      { href: '/money', label: 'Accounts', caps: ['money.manage_accounts', 'money.receive', 'money.record_payment'] },
      { href: '/money/receipt', label: 'Record receipt', caps: ['money.receive'] },
      { href: '/money/receipts', label: 'Receipts', caps: ['money.receive'] },
      { href: '/money/payments', label: 'Payments & authorisations', caps: ['money.record_payment', 'money.authorise_payment'] },
      { href: '/money/transfer', label: 'Transfers', caps: ['money.record_payment'] },
      { href: '/money/close', label: 'Period closes', caps: ['money.certify_close', 'money.manage_accounts'] },
      { href: '/money/instruments', label: 'Instruments', caps: ['money.manage_accounts'] },
      { href: '/money/refusals', label: 'Refusal register', caps: ['register.read', 'money.manage_incidents'] },
      { href: '/money/incidents', label: 'Incidents', caps: ['money.manage_incidents'] },
      { href: '/money/dormant', label: 'Dormant balances', caps: ['money.manage_dormancy'] },
      { href: '/money/registers', label: 'Statutory registers', caps: ['money.manage_accounts'] },
      { href: '/money/statements', label: 'Client statements', caps: ['money.issue_statements'] },
    ],
  },
  {
    section: 'Billing',
    items: [
      { href: '/billing', label: 'My time' },
      { href: '/billing/suggestions', label: 'Suggested time' },
      { href: '/billing/approvals', label: 'Bill approvals', caps: ['bill.approve'] },
      { href: '/billing/runs', label: 'Billing runs', caps: ['bill.issue'] },
      { href: '/billing/unpaid', label: 'Unpaid bills' },
      { href: '/billing/payments', label: 'Payments' },
      { href: '/billing/statements', label: 'Statements' },
      { href: '/billing/arrangements', label: 'Arrangements' },
      { href: '/billing/reminders', label: 'Reminders', caps: ['reminders.manage'] },
      { href: '/billing/channel', label: 'Online payments' },
      { href: '/billing/top-ups', label: 'Top-up requests' },
      { href: '/billing/held-funds', label: 'Held funds → bills', caps: ['money.apply_held_funds'] },
      { href: '/billing/rates', label: 'Rates & cost types' },
      { href: '/billing/payment-details', label: 'Payment details', caps: ['settings.manage', 'security.administer'] },
    ],
  },
  {
    section: 'Reports',
    items: [
      { href: '/reports', label: 'Catalogue' },
      { href: '/reports/schedules', label: 'Schedules' },
      { href: '/reports/targets', label: 'Targets & groups' },
    ],
  },
  {
    section: 'Firm accounts',
    items: [
      { href: '/finance', label: 'Office books', caps: ['gl.manage'] },
      { href: '/finance/reconcile', label: 'Bank reconciliation', caps: ['gl.manage'] },
      { href: '/finance/bills', label: 'Supplier bills', caps: ['gl.manage'] },
      { href: '/finance/reports', label: 'Financial reports', caps: ['gl.manage'] },
    ],
  },
  {
    section: 'Security',
    items: [
      { href: '/security/register', label: 'Register', caps: ['register.read'] },
      { href: '/outbound', label: 'Outbound messages', caps: ['security.administer', 'money.manage_accounts'] },
      { href: '/security/sign-ins', label: 'Sign-in history' },
      { href: '/security/staff', label: 'Staff' },
      { href: '/security/roles', label: 'Roles & capabilities', caps: ['roles.manage'] },
      { href: '/security/policy', label: 'Security policy', caps: ['security.administer'] },
      { href: '/security/mfa', label: 'MFA enrolment', caps: ['security.administer'] },
      { href: '/security/sessions', label: 'All sessions', caps: ['session.terminate_others'] },
      {
        href: '/security/examiners',
        label: 'Examiner access',
        caps: ['security.administer', 'money.grant_examiner'],
      },
      { href: '/security/exports', label: 'Export history' },
      { href: '/security/anomalies', label: 'Anomaly alerts', caps: ['security.administer'] },
      { href: '/security/restore', label: 'Deleted records', caps: ['deleted.restore'] },
      { href: '/security/resilience', label: 'Resilience', caps: ['security.administer'] },
    ],
  },
  {
    section: 'Configuration',
    items: [
      { href: '/settings', label: 'Firm settings', caps: ['settings.manage', 'security.administer'] },
      { href: '/settings/pack', label: 'Country pack', caps: ['pack.activate', 'security.administer'] },
      { href: '/settings/numbering', label: 'Numbering', caps: ['numbering.manage', 'security.administer'] },
      { href: '/settings/lists', label: 'Lists', caps: ['lists.manage', 'security.administer'] },
      { href: '/settings/fields', label: 'Custom fields', caps: ['fields.manage', 'security.administer'] },
      { href: '/settings/templates', label: 'Templates', caps: ['templates.manage', 'security.administer'] },
      { href: '/settings/assistant', label: 'Help articles', caps: ['assistant.manage', 'security.administer'] },
      { href: '/settings/practice-areas', label: 'Practice areas' },
      { href: '/settings/keys', label: 'Integration keys', caps: ['keys.manage'] },
      { href: '/imports', label: 'Imports', caps: ['import.execute'] },
      {
        href: '/settings/private-layer',
        label: 'Private layer',
        caps: ['private_layer.manage', 'security.administer'],
      },
      { href: '/settings/exceptions', label: 'Exceptions routing' },
    ],
  },
]

async function signOut(): Promise<void> {
  'use server'
  await signOutCookieSession()
  redirect('/sign-in')
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const principal = await requirePrincipal()
  if (principal.kind === 'examiner') redirect('/examiner')
  const viewer = await viewerContext(principal)
  const brand = await readBrand()
  // The installation's own menu links (setting nav.firm_links, 0057) — a
  // display-only convenience that must never break the shell: any failure
  // reads as "no extra links".
  const firmLinksText = await withPrincipal(
    principal,
    (tx) => settingText(tx, 'nav.firm_links'),
    { readOnly: true },
  ).catch(() => '')
  const navGroups = mergeNavGroups(NAV, parseFirmNavLinks(firmLinksText ?? ''))
  return (
    <div className="flex min-h-screen bg-neutral-50">
      <aside className="w-56 shrink-0 border-r border-neutral-200 bg-white print:hidden">
        <div className="px-4 py-4">
          <Link href="/" className="block" aria-label={`${brand.name} — home`}>
            {/* the installation's lockup — the firm's own if white-labelled, else the product's */}
            <img src={brand.logoHref} alt={brand.name} className="h-8 w-auto" />
          </Link>
        </div>
        <nav className="px-2 pb-6">
          {navGroups.map((group) => {
            const items = group.items.filter(
              (i) => !i.caps || i.caps.some((c) => viewer.capabilities.has(c)),
            )
            if (items.length === 0) return null
            return (
              <div key={group.section} className="mb-4">
                <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  {group.section}
                </p>
                {items.map((i) => (
                  <Link
                    key={i.href}
                    href={i.href}
                    className="block rounded px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-100"
                  >
                    {i.label}
                  </Link>
                ))}
              </div>
            )
          })}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-end gap-3 border-b border-neutral-200 bg-white px-6 py-2 print:hidden">
          <Link href="/account" className="text-sm text-neutral-600 hover:underline">
            {viewer.name}
          </Link>
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
