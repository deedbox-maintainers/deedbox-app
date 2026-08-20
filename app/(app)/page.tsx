// Home: pins, recents (predicate at render), my open tasks in due-date
// order, my pending proposals, quick capture. The dashboards carry the
// figures; home carries the person's own working set.

import Link from 'next/link'
import { requirePrincipal, viewerContext } from '@/lib/auth'
import { homeScreen } from '@/lib/reads/experience'
import { Page, Panel, DataTable, EmptyState, Notices, RowLink, Badge, fmtDate } from '@/components/ui'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { unpinAction } from './actions'
import { readBrand, PRODUCT_NAME } from '@/lib/brand'
import { keepDefaultBrandingAction } from './settings/actions'
import { SubmitButton } from '@/components/forms'

export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const viewer = await viewerContext(p)
  const d = await homeScreen(p)
  const brand = await readBrand()
  const canBrand = viewer.capabilities.has('security.administer') || viewer.capabilities.has('private_layer.manage')

  return (
    <Page
      title={`Welcome, ${viewer.name}`}
      lead={
        <span className="flex flex-wrap gap-3">
          <Link className="underline hover:text-neutral-800" href="/matters/new">
            New matter
          </Link>
          <Link className="underline hover:text-neutral-800" href="/parties/new">
            New person or organisation
          </Link>
          <Link className="underline hover:text-neutral-800" href="/billing">
            Record time
          </Link>
          <Link className="underline hover:text-neutral-800" href="/money/receipt">
            Record receipt
          </Link>
          <Link className="underline hover:text-neutral-800" href="/search">
            Search everything
          </Link>
        </span>
      }
    >
      <Notices searchParams={sp} />
      {!brand.decided && canBrand ? (
        <Panel title="Your look: make it your firm's, or keep it as it is">
          <p className="text-sm text-neutral-700">
            This installation is wearing the {PRODUCT_NAME} default name and logo. You can give it your firm's own
            name, logo, browser-tab icon and colours — every page, the sign-in screen and signed documents will
            carry them — or simply keep the {PRODUCT_NAME} look. Either is fine, and you can change your mind
            later under Configuration → Firm settings → Branding. Only administrators see this.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Link
              href="/settings"
              className="rounded-md bg-[var(--brand-primary,#171717)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              Make it your firm's
            </Link>
            <form action={keepDefaultBrandingAction}>
              <SubmitButton tone="quiet">Leave it as {PRODUCT_NAME}</SubmitButton>
            </form>
          </div>
        </Panel>
      ) : null}
      {d.pendingProposals > 0 ? (
        <Panel title="Awaiting confirmation">
          <p className="text-sm text-neutral-700">
            <RowLink href="/proposals">
              {d.pendingProposals} date or assignment change{d.pendingProposals === 1 ? '' : 's'}{' '}
              await confirmation
            </RowLink>{' '}
            — nothing moves until a person confirms.
          </p>
        </Panel>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Pinned">
          {d.pins.length === 0 ? (
            <EmptyState>Pin matters you use often; your recent items will appear here.</EmptyState>
          ) : (
            <ul className="space-y-1">
              {d.pins.map((x) => (
                <li key={`${x.item_type}-${x.item}`} className="flex items-center justify-between gap-2 text-sm">
                  <RowLink href={x.item_type === 'matter' ? `/matters/${x.item}` : `/parties/${x.item}`}>
                    {String(x.title)}
                  </RowLink>
                  <form action={unpinAction}>
                    <input type="hidden" name="item_type" value={String(x.item_type)} />
                    <input type="hidden" name="item" value={String(x.item)} />
                    <input type="hidden" name="back" value="/" />
                    <button className="text-xs text-neutral-400 hover:text-neutral-700" type="submit">
                      unpin
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Recent">
          {d.recents.length === 0 ? (
            <EmptyState>Your recent items will appear here.</EmptyState>
          ) : (
            <ul className="space-y-1">
              {d.recents.map((x) => (
                <li key={`${x.item_type}-${x.item}`} className="text-sm">
                  <RowLink href={x.item_type === 'matter' ? `/matters/${x.item}` : `/parties/${x.item}`}>
                    {String(x.title)}
                  </RowLink>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <Panel title="My open tasks">
        {d.tasks.length === 0 ? (
          <EmptyState>Nothing due — well done.</EmptyState>
        ) : (
          <DataTable
            headers={['Task', 'Matter', 'Due', '']}
            rows={d.tasks.map((t) => [
              String(t.title),
              t.matter ? (
                <RowLink key="m" href={`/matters/${t.matter}/workflow`}>
                  {String(t.matter_number)}
                </RowLink>
              ) : (
                '—'
              ),
              t.due_date ? (
                <span key="d">
                  {fmtDate(t.due_date)} {t.overdue ? <Badge tone="red">overdue</Badge> : null}
                </span>
              ) : (
                '—'
              ),
              <RowLink key="q" href="/tasks">
                Open queue
              </RowLink>,
            ])}
          />
        )}
      </Panel>
    </Page>
  )
}
