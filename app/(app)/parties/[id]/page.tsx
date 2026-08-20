// Party profile: every name the party has carried, contacts, addresses,
// links both directions, custom fields, the matters the viewer may see,
// notes, and the merge-history line. Merged parties render read-only with
// the survivor pointer.

import Link from 'next/link'
import { requirePrincipal } from '@/lib/auth'
import { recordView } from '@/lib/ops/reports'
import { partyProfile, matterFilterOptions, openMerges } from '@/lib/reads/matters'
import { partyPortalInvites } from '@/lib/reads/portal'
import { Page, Panel, DataTable, DetailList, Notices, RowLink, Badge, EmptyState, fmtDateTime } from '@/components/ui'
import { Field, TextInput, TextArea, Select, SubmitButton, InlineAction, Checkbox } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  renamePartyAction,
  createPortalInviteAction,
  revokePortalInviteAction,
  addNameAction,
  addContactAction,
  removeContactAction,
  addAddressAction,
  linkPartiesAction,
  addPartyNoteAction,
  removePartyNoteAction,
  undoMergeAction,
} from '../actions'

export default async function PartyProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const profile = await partyProfile(p, Number(id))
  const invites = await partyPortalInvites(p, Number(id))
  const options = await matterFilterOptions(p)
  const merges = await openMerges(p)
  const undoable = merges.filter((m) => m.survivor === profile.party.id)
  const merged = profile.party.state === 'merged'
  if (!merged) await recordView(p, { itemType: 'party', item: Number(id) })

  return (
    <Page
      title={profile.party.displayName}
      lead={
        merged ? (
          <span>
            This record was merged into{' '}
            <RowLink href={`/parties/${profile.party.mergedInto}`}>
              {profile.party.mergedIntoName}
            </RowLink>{' '}
            — it is kept for history and appears in no picker.
          </span>
        ) : (
          `${profile.party.kind === 'person' ? 'Person' : 'Organisation'} — everything the firm holds about them.`
        )
      }
      actions={
        merged ? undefined : (
          <Link
            href={`/parties/${profile.party.id}/merge`}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            Merge duplicate into this
          </Link>
        )
      }
    >
      <Notices searchParams={sp} />

      {undoable.map((m) => (
        <div
          key={m.merge}
          className="mb-4 flex items-center justify-between rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          <span>
            “{m.absorbedName}” was merged into this party on {fmtDateTime(m.performedAt)}. Undo
            stays open for the firm’s window.
          </span>
          <form action={undoMergeAction} className="flex items-center gap-2">
            <input type="hidden" name="merge" value={m.merge} />
            <input type="hidden" name="survivor" value={profile.party.id} />
            <TextInput name="reason" required placeholder="Reason (recorded)" className="!w-44" />
            <SubmitButton tone="quiet">Undo merge</SubmitButton>
          </form>
        </div>
      ))}

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <div>
          <Panel title="Names">
            <DataTable
              headers={['Name', 'Kind']}
              rows={profile.names.map((n) => [
                n.fullName,
                <Badge key="k" tone={n.kind === 'current' ? 'green' : 'neutral'}>
                  {n.kind.replace('_', ' ')}
                </Badge>,
              ])}
            />
            {!merged ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-sky-700">
                  Rename / add another name
                </summary>
                <div className="mt-3 grid grid-cols-1 gap-6 md:grid-cols-2">
                  <form action={renamePartyAction}>
                    <input type="hidden" name="party" value={profile.party.id} />
                    <Field label="New current name" hint="The old name is kept and stays searchable">
                      <TextInput name="full_name" required />
                    </Field>
                    <SubmitButton tone="quiet">Rename</SubmitButton>
                  </form>
                  <form action={addNameAction}>
                    <input type="hidden" name="party" value={profile.party.id} />
                    <Field label="Additional name">
                      <TextInput name="full_name" required />
                    </Field>
                    <Field label="Kind">
                      <Select name="name_kind" defaultValue="also_known_as">
                        <option value="also_known_as">Also known as</option>
                        <option value="former">Former name</option>
                        <option value="trading">Trading name</option>
                      </Select>
                    </Field>
                    <SubmitButton tone="quiet">Add name</SubmitButton>
                  </form>
                </div>
              </details>
            ) : null}
          </Panel>

          <Panel title="Contact details">
            <DataTable
              headers={['Kind', 'Value', 'Label', '', '']}
              rows={profile.contacts.map((c) => [
                c.kind,
                c.value,
                c.label ?? '—',
                c.isPrimary ? <Badge key="p" tone="blue">primary</Badge> : '',
                merged ? (
                  ''
                ) : (
                  <InlineAction
                    key="rm"
                    action={removeContactAction}
                    fields={{ party: profile.party.id, contact: c.id }}
                    label="Remove"
                  />
                ),
              ])}
              emptyState="No contact details recorded."
            />
            {!merged ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-sky-700">Add contact</summary>
                <form action={addContactAction} className="mt-3 max-w-md">
                  <input type="hidden" name="party" value={profile.party.id} />
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Kind">
                      <Select name="contact_kind" defaultValue="phone">
                        <option value="phone">Phone</option>
                        <option value="email">Email</option>
                      </Select>
                    </Field>
                    <Field label="Label" hint="e.g. work, mobile">
                      <TextInput name="label" />
                    </Field>
                  </div>
                  <Field label="Value">
                    <TextInput name="value" required />
                  </Field>
                  <Checkbox name="primary" label="Make this the primary" />
                  <SubmitButton tone="quiet">Add contact</SubmitButton>
                </form>
              </details>
            ) : null}
          </Panel>

          <Panel title="Addresses">
            <DataTable
              headers={['Kind', 'Address', '']}
              rows={profile.addresses.map((a) => [
                a.kind,
                [a.lines, a.locality, a.region, a.postcode, a.country].filter(Boolean).join(', '),
                a.current ? <Badge key="c" tone="blue">current</Badge> : '',
              ])}
              emptyState="No addresses recorded — an address is never mandatory."
            />
            {!merged ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-sky-700">Add address</summary>
                <form action={addAddressAction} className="mt-3 max-w-md">
                  <input type="hidden" name="party" value={profile.party.id} />
                  <Field label="Kind">
                    <Select name="address_kind" defaultValue="postal">
                      <option value="postal">Postal</option>
                      <option value="street">Street</option>
                      <option value="billing">Billing</option>
                      <option value="other">Other</option>
                    </Select>
                  </Field>
                  <Field label="Lines">
                    <TextInput name="lines" />
                  </Field>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Locality">
                      <TextInput name="locality" />
                    </Field>
                    <Field label="Region">
                      <TextInput name="region" />
                    </Field>
                    <Field label="Postcode">
                      <TextInput name="postcode" />
                    </Field>
                  </div>
                  <Field label="Country">
                    <TextInput name="country" />
                  </Field>
                  <SubmitButton tone="quiet">Add address</SubmitButton>
                </form>
              </details>
            ) : null}
          </Panel>

          {profile.customFields.length > 0 ? (
            <Panel title="Custom fields">
              <DetailList items={profile.customFields.map((f) => [f.label, String(f.value ?? '—')])} />
            </Panel>
          ) : null}
        </div>

        <div>
          <Panel title="Matters">
            <DataTable
              headers={['Matter', 'Title', 'Capacity', 'Status']}
              rows={profile.matters.map((m) => [
                <RowLink key="n" href={`/matters/${m.id}`}>
                  {m.matterNumber}
                </RowLink>,
                m.title,
                m.capacity,
                <Badge key="s" tone={m.status === 'open' ? 'green' : 'neutral'}>
                  {m.status.replace('_', ' ')}
                </Badge>,
              ])}
              emptyState="No matters yet."
            />
          </Panel>

          <Panel title="Relationships">
            <DataTable
              headers={['Relationship', 'With', 'Note']}
              rows={profile.links.map((l) => [
                `${l.kindLabel}${l.direction === 'in' ? ' (of)' : ''}`,
                <RowLink key="o" href={`/parties/${l.otherParty}`}>
                  {l.otherName}
                </RowLink>,
                l.note ?? '—',
              ])}
              emptyState="No relationships recorded."
            />
            {!merged ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-sky-700">Link to another party</summary>
                <form action={linkPartiesAction} className="mt-3 max-w-md">
                  <input type="hidden" name="party" value={profile.party.id} />
                  <Field label="Other party" hint="The number from their profile page's address bar">
                    <TextInput name="to_party" required inputMode="numeric" />
                  </Field>
                  <Field label="Relationship">
                    <Select name="link_kind">
                      {options.linkKinds.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Note">
                    <TextInput name="note" />
                  </Field>
                  <SubmitButton tone="quiet">Link</SubmitButton>
                </form>
              </details>
            ) : null}
          </Panel>

          <Panel title="Notes">
            {profile.notes.length === 0 ? (
              <EmptyState>No notes yet.</EmptyState>
            ) : (
              <ul className="space-y-3">
                {profile.notes.map((n) => (
                  <li key={n.id} className="rounded-md border border-neutral-100 bg-neutral-50 p-3 text-sm">
                    <p className="whitespace-pre-wrap text-neutral-800">{n.body}</p>
                    <div className="mt-1 flex items-center justify-between text-xs text-neutral-400">
                      <span>{fmtDateTime(n.notedAt)}</span>
                      {!merged ? (
                        <InlineAction
                          action={removePartyNoteAction}
                          fields={{ party: profile.party.id, note: n.id }}
                          label="Remove"
                        />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {!merged ? (
              <form action={addPartyNoteAction} className="mt-3">
                <input type="hidden" name="party" value={profile.party.id} />
                <Field label="New note">
                  <TextArea name="body" rows={2} required />
                </Field>
                <SubmitButton tone="quiet">Add note</SubmitButton>
              </form>
            ) : null}
          </Panel>

          {profile.absorbed.length > 0 ? (
            <Panel title="Merge history">
              <DataTable
                headers={['Absorbed party', 'When', 'State']}
                rows={profile.absorbed.map((m) => [
                  m.absorbedName,
                  fmtDateTime(m.performedAt),
                  m.undoneAt ? <Badge key="u">undone</Badge> : <Badge key="u" tone="green">stands</Badge>,
                ])}
              />
            </Panel>
          ) : null}

          <Panel title="Client portal">
            {invites.length > 0 && (
              <DataTable
                headers={['Email', 'Expires', 'Accepted', 'Last sign-in', 'Standing', '']}
                rows={invites.map((i) => [
                  i.email,
                  fmtDateTime(i.expiresAt),
                  i.acceptedAt ? fmtDateTime(i.acceptedAt) : '—',
                  i.lastLoginAt ? fmtDateTime(i.lastLoginAt) : '—',
                  i.revoked ? <Badge key="r" tone="red">revoked</Badge> : i.acceptedAt ? <Badge key="r" tone="green">active</Badge> : 'pending',
                  i.revoked ? null : (
                    <form key="x" action={revokePortalInviteAction}>
                      <input type="hidden" name="party" value={profile.party.id} />
                      <input type="hidden" name="invite" value={i.id} />
                      <SubmitButton tone="danger">Revoke</SubmitButton>
                    </form>
                  ),
                ])}
              />
            )}
            <form action={createPortalInviteAction}>
              <input type="hidden" name="party" value={profile.party.id} />
              <Field label="Invite email">
                <TextInput name="email" type="email" required />
              </Field>
              <Field label="Expires after (days, default 14)">
                <TextInput name="expires_days" type="number" />
              </Field>
              <SubmitButton>Create portal invitation — link shown once</SubmitButton>
            </form>
            <p>
              What the client sees is governed by the per-matter portal switch on each matter&apos;s
              parties panel; revoking an invitation ends their sessions immediately.
            </p>
          </Panel>
        </div>
      </div>
    </Page>
  )
}
