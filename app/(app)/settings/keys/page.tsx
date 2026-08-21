// Integration keys: label, display form, issue/last-used, rate limit,
// test badge, revoke. The secret exists only in the issuing response.

import { requirePrincipal } from '@/lib/auth'
import { keysScreen } from '@/lib/reads/operations'
import { Page, Panel, DataTable, EmptyState, Notices, RowLink, Badge, fmtDateTime, personName, fmtJson } from '@/components/ui'
import { Field, TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { issueKeyAction, revokeKeyAction } from './actions'

export default async function KeysPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const keys = await keysScreen(p)

  return (
    <Page
      title="Integration keys"
      lead="Keys accept records from your website or other systems. Senders can never set any financial field or classify their submissions, and can read nothing — unless you switch on template reading for a specific key, which opens the firm's document templates to it and nothing else."
    >
      <Notices searchParams={sp} />
      <Panel title={`${keys.length} key(s)`}>
        {keys.length === 0 ? (
          <EmptyState>No keys — issue one to accept records from your website or other systems.</EmptyState>
        ) : (
          <DataTable
            headers={['Label', 'Key', 'Issued', 'Last used', 'Rate limit', 'Mode', 'Reads', 'State', '', '']}
            rows={keys.map((k) => [
              String(k.label),
              String(k.key_display),
              <span key="i">
                {fmtDateTime(k.issued_at)} by {personName(k.issued_by_name)}
              </span>,
              k.last_used_at ? fmtDateTime(k.last_used_at) : 'never',
              fmtJson(k.rate_limit),
              k.test_mode ? <Badge key="t" tone="violet">test</Badge> : 'live',
              k.templates_read ? <Badge key="tr" tone="amber">templates</Badge> : 'nothing',
              k.revoked_at ? <Badge key="r" tone="red">revoked</Badge> : <Badge key="r" tone="green">active</Badge>,
              <RowLink key="o" href={`/settings/keys/${k.id}`}>
                Activity
              </RowLink>,
              !k.revoked_at ? (
                <form key="x" action={revokeKeyAction}>
                  <input type="hidden" name="key" value={String(k.id)} />
                  <SubmitButton>Revoke</SubmitButton>
                </form>
              ) : (
                ''
              ),
            ])}
          />
        )}
      </Panel>
      <Panel title="Issue a key">
        <form action={issueKeyAction} className="flex flex-wrap items-end gap-3">
          <Field label="Label">
            <TextInput name="label" />
          </Field>
          <label className="mb-2 flex items-center gap-1 text-sm text-neutral-600">
            <input type="checkbox" name="test_mode" /> test mode (its records appear on no business
            surface)
          </label>
          <SubmitButton>Issue — the secret shows once</SubmitButton>
        </form>
      </Panel>
    </Page>
  )
}
