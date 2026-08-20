// Firm-accounts index: dark = an honest set-up panel; lit =
// the doors with live counts and the manual bridge run.

import Link from 'next/link'
import { requirePrincipal } from '@/lib/auth'
import { glStatus } from '@/lib/reads/gl'
import { Page, Panel, Notices, EmptyState } from '@/components/ui'
import { SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { syncNowAction } from './actions'

export default async function FinancePage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const status = await glStatus(p)
  return (
    <Page
      title="Firm accounts"
      lead="The firm's own office accounting: chart, journals, supplier bills, bank reconciliation and financial reports. Optional — many firms keep their books in an external ledger instead."
    >
      <Notices searchParams={sp} />
      {!status.mayManage ? (
        <EmptyState>Your role does not include operating the firm accounts.</EmptyState>
      ) : !status.enabled ? (
        <Panel title="Not switched on">
          <p className="mb-3 text-sm text-neutral-600">
            The office-accounting module is dark. Switching it on seeds a starter chart of
            accounts and sets the date your books begin here; nothing about matters, billing or
            client money changes.
          </p>
          <Link
            href="/finance/settings"
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
          >
            Set up the books
          </Link>
        </Panel>
      ) : (
        <>
          <Panel title="Doors">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {[
                ['/finance/reconcile', `Reconcile (${status.unmatchedLines} waiting)`],
                ['/finance/bills', `Supplier bills (${status.draftBills} drafts)`],
                ['/finance/journals', 'Journals'],
                ['/finance/accounts', `Chart (${status.accounts} accounts)`],
                ['/finance/contacts', 'Contacts'],
                ['/finance/reports', 'Reports'],
                ['/finance/settings', 'Settings & periods'],
              ].map(([href, label]) => (
                <Link
                  key={href}
                  href={href}
                  className="rounded-lg border border-neutral-200 bg-white px-3 py-3 text-sm text-neutral-800 hover:bg-neutral-50"
                >
                  {label}
                </Link>
              ))}
            </div>
          </Panel>
          <Panel title="Practice bridge">
            <p className="mb-2 text-xs text-neutral-500">
              Issued bills, payments, credits and write-offs from the practice side post
              themselves into the ledger on schedule; run it now if you want the books current
              this minute. Books begin {status.conversionDate}.
            </p>
            <form action={syncNowAction}>
              <SubmitButton tone="quiet">Run the bridge now</SubmitButton>
            </form>
          </Panel>
        </>
      )}
    </Page>
  )
}
