// The instrument register: both directions, stale and long-outstanding
// highlighted, dishonour on the bank's authority, cancellation under
// authorisation, replacement linkage.

import { requirePrincipal } from '@/lib/auth'
import { instrumentRegister } from '@/lib/reads/money'
import { Page, Panel, DataTable, Notices, Badge, fmtDate } from '@/components/ui'
import { Select, SubmitButton, TextInput, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { bankInstrumentAction, dishonourAction, cancelInstrumentAction, linkReplacementAction } from '../actions'

export default async function InstrumentsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const rows = await instrumentRegister(p, {
    direction: sp.direction || undefined,
    state: sp.state || undefined,
  })

  return (
    <Page
      title="Instruments"
      lead="Cheques and their kin, both directions. A dishonour is recorded on the bank's authority and posts its own reversal; an outbound cancellation needs an authorisation."
    >
      <Notices searchParams={sp} />
      <Panel>
        <form method="get" className="mb-4 flex items-end gap-3 text-sm">
          <Select name="direction" defaultValue={sp.direction ?? ''} className="w-32">
            <option value="">Both ways</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
          </Select>
          <Select name="state" defaultValue={sp.state ?? ''} className="w-36">
            <option value="">Any state</option>
            <option value="received">Received</option>
            <option value="banked">Banked</option>
            <option value="cleared">Cleared</option>
            <option value="dishonoured">Dishonoured</option>
            <option value="created">Created</option>
            <option value="presented">Presented</option>
            <option value="stale">Stale</option>
            <option value="cancelled">Cancelled</option>
            <option value="replaced">Replaced</option>
          </Select>
          <SubmitButton tone="quiet">Filter</SubmitButton>
        </form>
        <DataTable
          headers={['Account', 'Dir', 'Kind', 'Number', 'Amount', 'State', 'Stale after', 'Act']}
          rows={rows.map((i) => [
            String(i.account_name),
            String(i.direction),
            String(i.instrument_kind),
            String(i.number),
            Number(i.amount).toFixed(2),
            <span key="s">
              <Badge
                tone={
                  ['cleared', 'presented'].includes(String(i.state))
                    ? 'green'
                    : ['dishonoured', 'stale'].includes(String(i.state))
                      ? 'red'
                      : 'blue'
                }
              >
                {String(i.state)}
              </Badge>
              {Number(i.days_past_stale) > 0 && !['cancelled', 'replaced', 'cleared', 'presented', 'dishonoured'].includes(String(i.state)) ? (
                <Badge tone="red"> {String(i.days_past_stale)}d past stale</Badge>
              ) : null}
            </span>,
            fmtDate(i.stale_after),
            <div key="acts" className="space-y-1">
              {i.state === 'received' ? (
                <InlineAction action={bankInstrumentAction} fields={{ instrument: i.id as number }} label="Banked" />
              ) : null}
              {['received', 'banked'].includes(String(i.state)) ? (
                <form action={dishonourAction} className="flex items-center gap-1">
                  <input type="hidden" name="instrument" value={i.id as number} />
                  <TextInput name="evidence" placeholder="Bank evidence" className="!w-32" />
                  <TextInput name="honoured_amount" placeholder="Part honoured?" inputMode="decimal" className="!w-28" />
                  <SubmitButton tone="quiet">Dishonour</SubmitButton>
                </form>
              ) : null}
              {['created', 'stale'].includes(String(i.state)) ? (
                <form action={cancelInstrumentAction} className="flex items-center gap-1">
                  <input type="hidden" name="instrument" value={i.id as number} />
                  <TextInput name="reason" placeholder="Reason" className="!w-28" />
                  <TextInput name="authorisation" placeholder="Auth #" inputMode="numeric" className="!w-20" />
                  <SubmitButton tone="quiet">Cancel</SubmitButton>
                </form>
              ) : null}
              {i.state === 'cancelled' && !i.replaced_by ? (
                <form action={linkReplacementAction} className="flex items-center gap-1">
                  <input type="hidden" name="cancelled" value={i.id as number} />
                  <TextInput name="replacement" placeholder="Replacement #" inputMode="numeric" className="!w-28" />
                  <SubmitButton tone="quiet">Link</SubmitButton>
                </form>
              ) : null}
            </div>,
          ])}
          emptyState="No instruments recorded."
        />
      </Panel>
    </Page>
  )
}
