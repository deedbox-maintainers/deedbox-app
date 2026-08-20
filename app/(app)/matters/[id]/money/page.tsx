// The matter money tab (+ earmarks, entitlements): per-ledger
// balance/available, set-asides, entitlements with derived status, recent
// lines, outstanding instruments, statements, and the ledger lifecycle.

import { requirePrincipal } from '@/lib/auth'
import { matterMoneyTab } from '@/lib/reads/money'
import { Page, Panel, DataTable, Notices, RowLink, Badge, EmptyState, fmtDate, fmtDateTime } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  placeEarmarkAction,
  releaseEarmarkAction,
  establishEntitlementAction,
  entitlementNoticeAction,
  cancelEntitlementAction,
  openLedgerAction,
  closeLedgerAction,
  reopenLedgerAction,
} from '../../../money/actions'

export default async function MatterMoneyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const t = await matterMoneyTab(p, Number(id))
  const m = t.matter

  return (
    <Page
      title={`Client money — ${m.matter_number}`}
      lead={
        <span>
          {m.title} — <RowLink href={`/matters/${m.id}`}>back to the matter</RowLink>. Balances are
          the journal's own; nothing here can be typed over.
        </span>
      }
    >
      <Notices searchParams={sp} />

      {t.dormantCases.length > 0 ? (
        <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {t.dormantCases.length} dormant-money case(s) open on this matter's ledgers —{' '}
          <RowLink href="/money/dormant">the dormant balances queue</RowLink>. They never block the
          matter closing; the ledger resolves them on its own track.
        </p>
      ) : null}

      <Panel title="Ledgers">
        <DataTable
          headers={['Ledger', 'Account', 'Balance', 'Set aside', 'Available', 'State', '', '']}
          rows={t.ledgers.map((l) => [
            <RowLink key="l" href={`/money/ledgers/${l.id}`}>
              {l.ledgerNumber}
            </RowLink>,
            l.accountName,
            <span key="b" className="tabular-nums">{l.balance.toFixed(2)}</span>,
            <span key="e" className="tabular-nums">{l.earmarked.toFixed(2)}</span>,
            <span key="a" className="tabular-nums font-medium">{l.available.toFixed(2)}</span>,
            <Badge key="s" tone={l.status === 'open' ? 'green' : 'neutral'}>{l.status}</Badge>,
            l.status === 'open' ? (
              <InlineAction
                key="cl"
                action={closeLedgerAction}
                fields={{ matter: m.id, ledger: l.id }}
                label="Close (needs exactly zero)"
              />
            ) : (
              ''
            ),
            l.status === 'closed' ? (
              <form key="ro" action={reopenLedgerAction} className="flex items-center gap-1">
                <input type="hidden" name="matter" value={m.id} />
                <input type="hidden" name="ledger" value={l.id} />
                <TextInput name="reason" placeholder="Reopen — reason" className="!w-36" />
                <SubmitButton tone="quiet">Reopen</SubmitButton>
              </form>
            ) : (
              ''
            ),
          ])}
          emptyState="No client money has been held for this matter."
        />
        <form action={openLedgerAction} className="mt-3 flex max-w-md items-end gap-2 border-t border-neutral-100 pt-3">
          <input type="hidden" name="matter" value={m.id} />
          <div className="grow">
            <Field label="Open a ledger on account">
              <Select name="account">
                {t.accountOptions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="pb-3">
            <SubmitButton tone="quiet">Open ledger</SubmitButton>
          </div>
        </form>
      </Panel>

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <div>
          <Panel title="Set-asides (earmarks)">
            <DataTable
              headers={['Ledger', 'Amount', 'Purpose', 'State', '']}
              rows={t.earmarks.map((e) => [
                String(t.ledgers.find((l) => l.id === e.matter_ledger)?.ledgerNumber ?? e.matter_ledger),
                Number(e.amount).toFixed(2),
                String(e.purpose),
                <Badge key="s" tone={e.state === 'active' ? 'blue' : 'neutral'}>{String(e.state)}</Badge>,
                e.state === 'active' ? (
                  <form key="r" action={releaseEarmarkAction} className="flex items-center gap-1">
                    <input type="hidden" name="matter" value={m.id} />
                    <input type="hidden" name="earmark" value={e.id as number} />
                    <TextInput
                      name="amount"
                      placeholder="Amount (blank = all)"
                      inputMode="decimal"
                      className="!w-32"
                    />
                    <TextInput name="reason" placeholder="Release — reason" className="!w-32" />
                    <SubmitButton tone="quiet">Release</SubmitButton>
                  </form>
                ) : (
                  ''
                ),
              ])}
              emptyState="No amounts set aside for a purpose on this ledger."
            />
            {t.ledgers.some((l) => l.status === 'open') ? (
              <form action={placeEarmarkAction} className="mt-3 grid max-w-md grid-cols-3 items-end gap-2 border-t border-neutral-100 pt-3">
                <input type="hidden" name="matter" value={m.id} />
                <Field label="Ledger">
                  <Select name="matter_ledger">
                    {t.ledgers
                      .filter((l) => l.status === 'open')
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.ledgerNumber} (avail {l.available.toFixed(2)})
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Amount">
                  <TextInput name="amount" required inputMode="decimal" />
                </Field>
                <Field label="Purpose">
                  <TextInput name="purpose" required />
                </Field>
                <div className="col-span-3">
                  <SubmitButton tone="quiet">Set aside</SubmitButton>
                </div>
              </form>
            ) : null}
          </Panel>

          <Panel title="Entitlements (rights to take held money)">
            <DataTable
              headers={['Amount', 'Basis', 'Status', '', '']}
              rows={t.entitlements.map((en) => [
                Number(en.amount).toFixed(2),
                en.basis_kind === 'rendered_bill'
                  ? `bill ${String(en.bill_number ?? en.bill)}`
                  : String(en.pack_basis),
                <Badge
                  key="s"
                  tone={
                    en.derived_status === 'actionable'
                      ? 'green'
                      : en.derived_status === 'cancelled'
                        ? 'neutral'
                        : 'amber'
                  }
                >
                  {String(en.derived_status)}
                </Badge>,
                en.derived_status === 'awaiting notice' ? (
                  <form key="n" action={entitlementNoticeAction} className="flex items-center gap-1">
                    <input type="hidden" name="matter" value={m.id} />
                    <input type="hidden" name="entitlement" value={en.id as number} />
                    <TextInput name="notice_event_type" placeholder="Evidence kind" className="!w-28" />
                    <TextInput name="notice_event" placeholder="Evidence #" inputMode="numeric" className="!w-24" />
                    <SubmitButton tone="quiet">Record notice</SubmitButton>
                  </form>
                ) : (
                  ''
                ),
                !en.cancelled_at ? (
                  <form key="c" action={cancelEntitlementAction} className="flex items-center gap-1">
                    <input type="hidden" name="matter" value={m.id} />
                    <input type="hidden" name="entitlement" value={en.id as number} />
                    <TextInput name="reason" placeholder="Cancel — reason" className="!w-28" />
                    <SubmitButton tone="quiet">Cancel</SubmitButton>
                  </form>
                ) : (
                  ''
                ),
              ])}
              emptyState="No entitlements — money leaves for the firm only through one."
            />
            {t.ledgers.some((l) => l.status === 'open') ? (
              <form action={establishEntitlementAction} className="mt-3 grid max-w-md grid-cols-3 items-end gap-2 border-t border-neutral-100 pt-3">
                <input type="hidden" name="matter" value={m.id} />
                <Field label="Ledger">
                  <Select name="matter_ledger">
                    {t.ledgers
                      .filter((l) => l.status === 'open')
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.ledgerNumber}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Amount">
                  <TextInput name="amount" required inputMode="decimal" />
                </Field>
                <Field label="Rendered bill #">
                  <TextInput name="bill" required inputMode="numeric" />
                </Field>
                <div className="col-span-3">
                  <SubmitButton tone="quiet">Establish on the bill</SubmitButton>
                </div>
              </form>
            ) : null}
          </Panel>
        </div>

        <div>
          <Panel title="Recent movements">
            <DataTable
              headers={['Ledger', '#', 'What', 'Amount', 'Balance', 'Date']}
              rows={t.recentLines.map((ll) => [
                String(t.ledgers.find((l) => l.id === ll.matter_ledger)?.ledgerNumber ?? ''),
                String(ll.entry_no),
                <span key="k">
                  {String(ll.txn_kind).replace(/_/g, ' ')}
                  {ll.reason ? <span className="text-neutral-400"> · {String(ll.reason)}</span> : null}
                </span>,
                Number(ll.signed_amount).toFixed(2),
                Number(ll.running_balance).toFixed(2),
                fmtDate(ll.effective_date),
              ])}
              emptyState="No movements yet."
            />
          </Panel>

          <Panel title="Outstanding instruments">
            <DataTable
              headers={['Direction', 'Kind', 'Number', 'Amount', 'State', 'Stale after']}
              rows={t.instruments.map((i) => [
                String(i.direction),
                String(i.instrument_kind),
                String(i.number),
                Number(i.amount).toFixed(2),
                <Badge key="s" tone="amber">{String(i.state)}</Badge>,
                fmtDate(i.stale_after),
              ])}
              emptyState="None outstanding."
            />
          </Panel>

          <Panel title="Client statements">
            <DataTable
              headers={['Number', 'Period', 'Issued']}
              rows={t.statements.map((s) => [
                String(s.statement_number),
                `${fmtDate(s.period_start)} – ${fmtDate(s.period_end)}`,
                s.issued_at ? `${fmtDateTime(s.issued_at)} (${String(s.issue_channel)})` : 'generated, unissued',
              ])}
              emptyState="No statements yet — generate one from the statements screen."
            />
          </Panel>
        </div>
      </div>
    </Page>
  )
}
