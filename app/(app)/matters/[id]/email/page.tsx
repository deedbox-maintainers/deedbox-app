// The matter email tab: the filed correspondence thread, a
// send-as-you form (the matter number is stamped into the subject so
// replies file themselves), and the matter's calendar events.

import { requirePrincipal } from '@/lib/auth'
import { matterEmailTab, myM365Connection } from '@/lib/reads/m365'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDateTime } from '@/components/ui'
import { Field, TextInput, TextArea, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { sendMatterEmailAction, createCalendarEventAction } from '../../actions'

export default async function MatterEmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const tab = await matterEmailTab(p, Number(id))
  const connection = await myM365Connection(p)
  const open = tab.matter.status !== 'closed' && tab.matter.status !== 'archived'

  return (
    <Page
      title={`Email — ${tab.matter.matterNumber}`}
      lead={
        <span>
          {tab.matter.title} — <RowLink href={`/matters/${tab.matter.id}`}>back to the matter</RowLink>.
          Replies carrying [{tab.matter.matterNumber}] in the subject file themselves on the next
          mail sweep.
        </span>
      }
    >
      <Notices searchParams={sp} />

      <Panel title="Correspondence">
        <DataTable
          headers={['When', 'Direction', 'From / To', 'Subject', 'Preview']}
          emptyState="Nothing filed yet."
          rows={tab.emails.map((e) => [
            fmtDateTime(e.occurredAt),
            e.direction === 'sent' ? <Badge key="d" tone="blue">sent</Badge> : <Badge key="d" tone="green">received</Badge>,
            e.direction === 'sent' ? e.toAddresses.join(', ') : e.fromAddress ?? '—',
            e.subject ?? '—',
            e.bodyPreview ?? '—',
          ])}
        />
      </Panel>

      {open && (
        <Panel title="Send an email (as you)">
          {!connection.connected ? (
            <p>
              Connect Microsoft 365 on <RowLink href="/account">your account page</RowLink> to send
              and to have tagged inbox mail filed automatically.
            </p>
          ) : (
            <form action={sendMatterEmailAction}>
              <input type="hidden" name="matter" value={tab.matter.id} />
              <Field label="To (comma-separated)">
                <TextInput name="to" required />
              </Field>
              <Field label="Cc">
                <TextInput name="cc" />
              </Field>
              <Field label="Subject" hint={`[${tab.matter.matterNumber}] is added when missing`}>
                <TextInput name="subject" required />
              </Field>
              <Field label="Message">
                <TextArea name="body" rows={6} required />
              </Field>
              <SubmitButton>Send and file</SubmitButton>
            </form>
          )}
        </Panel>
      )}

      <Panel title="Calendar">
        <DataTable
          headers={['When', 'Subject', 'Where', '']}
          emptyState="No events recorded."
          rows={tab.events.map((ev) => [
            `${fmtDateTime(ev.startsAt)}${ev.endsAt ? ` – ${fmtDateTime(ev.endsAt)}` : ''}`,
            ev.subject,
            ev.location ?? '—',
            ev.webLink ? (
              <a key="l" href={ev.webLink} target="_blank" rel="noreferrer">
                open
              </a>
            ) : null,
          ])}
        />
        {open && connection.connected && (
          <form action={createCalendarEventAction}>
            <input type="hidden" name="matter" value={tab.matter.id} />
            <Field label="Subject">
              <TextInput name="subject" required />
            </Field>
            <Field label="Starts">
              <input type="datetime-local" name="starts_at" required />
            </Field>
            <Field label="Ends">
              <input type="datetime-local" name="ends_at" />
            </Field>
            <Field label="Location">
              <TextInput name="location" />
            </Field>
            <SubmitButton>Create in your calendar</SubmitButton>
          </form>
        )}
      </Panel>
    </Page>
  )
}
