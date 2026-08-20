// Private-layer console: namespace lifecycle with a real database
// principal, configuration slots, declared-mount triage against the
// extension-point catalogue, and the violation log.

import { requirePrincipal } from '@/lib/auth'
import { privateLayerConsole } from '@/lib/reads/config'
import { mountCheck } from '@/lib/ops/config'
import { Page, Panel, Badge, DataTable, EmptyState, Notices, fmtDateTime } from '@/components/ui'
import { Field, TextInput, TextArea, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  registerNamespaceAction,
  rotateNamespaceSecretAction,
  suspendNamespaceAction,
  reinstateNamespaceAction,
  retireNamespaceAction,
  setConfigSlotAction,
} from '../actions'

export default async function PrivateLayerPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const { namespaces, slots, extensionPoints, violations } = await privateLayerConsole(p)
  const mounts = await mountCheck(p)
  const stateBadge = (s: string) =>
    s === 'registered' ? (
      <Badge tone="green">registered</Badge>
    ) : s === 'suspended' ? (
      <Badge tone="amber">suspended</Badge>
    ) : (
      <Badge tone="red">retired</Badge>
    )
  return (
    <Page
      title="Private layer"
      lead="The firm's own extension namespace: an isolated database principal that can read ONLY the issued views, declared extension mounts, and configuration slots. Its writes pass only through the public interfaces, so they are permission-checked and registered like anyone's."
    >
      <Notices searchParams={sp} />
      <Panel title="Namespaces">
        {namespaces.length === 0 ? (
          <EmptyState>No private namespace registered — register one below or download the empty template.</EmptyState>
        ) : (
          <div className="space-y-4">
            {namespaces.map((ns) => (
              <div key={ns.id} className="rounded border border-neutral-200 p-3">
                <p className="text-sm text-neutral-700">
                  <code>{ns.namespace}</code> — {ns.description} {stateBadge(ns.state)}{' '}
                  <span className="text-xs text-neutral-400">principal {ns.db_principal}</span>
                </p>
                {ns.state !== 'retired' && (
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <form action={rotateNamespaceSecretAction}>
                      <input type="hidden" name="namespace" value={ns.namespace} />
                      <SubmitButton>Rotate secret</SubmitButton>
                    </form>
                    {ns.state === 'registered' ? (
                      <form action={suspendNamespaceAction} className="flex items-end gap-2">
                        <input type="hidden" name="namespace" value={ns.namespace} />
                        <Field label="Suspension reason">
                          <TextInput name="reason" />
                        </Field>
                        <SubmitButton>Suspend</SubmitButton>
                      </form>
                    ) : (
                      <form action={reinstateNamespaceAction}>
                        <input type="hidden" name="namespace" value={ns.namespace} />
                        <SubmitButton>Reinstate</SubmitButton>
                      </form>
                    )}
                    <form action={retireNamespaceAction}>
                      <input type="hidden" name="namespace" value={ns.namespace} />
                      <SubmitButton>Retire (needs a full export within 7 days)</SubmitButton>
                    </form>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <form action={registerNamespaceAction} className="mt-4 max-w-lg space-y-2 border-t border-neutral-100 pt-3">
          <p className="text-sm font-medium text-neutral-700">Register a namespace</p>
          <Field label="Namespace (pl_…, lowercase and underscores)">
            <TextInput name="namespace" placeholder="pl_firm_package" />
          </Field>
          <Field label="What it is for">
            <TextInput name="description" />
          </Field>
          <Field label="Declared mounts (optional JSON list of {point, title})">
            <TextArea name="declared_mounts" rows={2} placeholder='[{"point":"matter.side_panel","title":"Panel"}]' />
          </Field>
          <SubmitButton>Register — the principal secret shows once</SubmitButton>
        </form>
      </Panel>

      <Panel title="Declared mounts (checked against the catalogue)">
        {mounts.current.length + mounts.deprecated.length + mounts.retired.length + mounts.unknown.length === 0 ? (
          <EmptyState>No mounts are declared by a registered namespace.</EmptyState>
        ) : (
          <DataTable
            headers={['Namespace', 'Point', 'Title', 'Verdict']}
            rows={[
              ...mounts.current.map((m) => [m.namespace, m.point, m.title ?? '—', <Badge key="b" tone="green">loads</Badge>]),
              ...mounts.deprecated.map((m) => [m.namespace, m.point, m.title ?? '—', <Badge key="b" tone="amber">deprecated — re-point before retirement</Badge>]),
              ...mounts.retired.map((m) => [m.namespace, m.point, m.title ?? '—', <Badge key="b" tone="red">refused — point retired</Badge>]),
              ...mounts.unknown.map((m) => [m.namespace, m.point, m.title ?? '—', <Badge key="b" tone="red">refused — no such point</Badge>]),
            ]}
          />
        )}
      </Panel>

      <Panel title="Configuration slots">
        <DataTable
          headers={['Slot', 'Entry', 'Value']}
          emptyState="No configuration slots are set."
          rows={slots.map((s) => [
            s.slot,
            s.entry_key,
            <code key="v" className="text-xs">
              {JSON.stringify(s.value)}
            </code>,
          ])}
        />
        <form action={setConfigSlotAction} className="mt-3 max-w-lg space-y-2 border-t border-neutral-100 pt-3">
          <p className="text-sm font-medium text-neutral-700">Set a slot</p>
          <Field label="Slot">
            <Select name="slot" defaultValue="branding">
              <option value="branding">branding</option>
              <option value="bank_details">bank_details (money-significant)</option>
              <option value="timezone_display">timezone_display</option>
              <option value="custom_entry">custom_entry (pl_-namespaced key)</option>
            </Select>
          </Field>
          <Field label="Entry key">
            <TextInput name="entry_key" placeholder="default" />
          </Field>
          <Field label="Value (JSON document)">
            <TextArea name="value" rows={2} placeholder='{"display_name":"…"}' />
          </Field>
          <SubmitButton>Save slot</SubmitButton>
        </form>
      </Panel>

      <Panel title="Violation log (private_layer_violation)">
        <DataTable
          headers={['When', 'Summary', 'Acknowledged']}
          emptyState="No view-contract violations have been reported."
          rows={violations.map((v) => [
            fmtDateTime(v.raised_at),
            v.summary,
            v.acknowledged_at ? fmtDateTime(v.acknowledged_at) : '—',
          ])}
        />
      </Panel>

      <Panel title="Extension points">
        <DataTable
          headers={['Point', 'Location', 'Contract', 'State']}
          emptyState="No extension points are declared by this release."
          rows={extensionPoints.map((e) => [
            e.point_key,
            e.location,
            e.contract_version,
            e.deprecation_state === 'current' ? (
              <Badge tone="green">current</Badge>
            ) : e.deprecation_state === 'deprecated' ? (
              <Badge tone="amber">deprecated</Badge>
            ) : (
              <Badge tone="red">retired</Badge>
            ),
          ])}
        />
      </Panel>
    </Page>
  )
}
