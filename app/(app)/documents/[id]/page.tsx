// Document detail: metadata, the immutable version history,
// checkout/checkin, the admin lock and legal hold (documents.manage), soft
// delete and window-bound restore, and the access trail. Rendering this
// page records a 'viewed' access row.

import { requirePrincipal } from '@/lib/auth'
import { documentDetail } from '@/lib/reads/documents'
import { recordDocumentAccess } from '@/lib/ops/documents'
import { officeOpenLink } from '@/lib/ops/documents/dav'
import OcrPanel from './ocr-panel'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDateTime } from '@/components/ui'
import { Field, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  addVersionAction,
  editDocumentAction,
  checkoutDocumentAction,
  checkinDocumentAction,
  setDocumentLockAction,
  setLegalHoldAction,
  softDeleteDocumentAction,
  restoreDocumentAction,
  createShareAction,
  revokeShareAction,
  createSigningRequestAction,
  revokeSigningRequestAction,
} from '../actions'

export default async function DocumentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const detail = await documentDetail(p, Number(id))
  const d = detail.document
  await recordDocumentAccess(p, { document: d.id, action: 'viewed' })

  const current = detail.versions[0]
  const office =
    current && !d.softDeletedAt
      ? officeOpenLink({ document: d.id, filename: current.filename, staff: p.id, firm: p.firm })
      : null
  const ocrEligible =
    current &&
    !d.softDeletedAt &&
    current.textMethod === 'none' &&
    /\.(pdf|png|jpe?g|webp|bmp|tiff?)$/i.test(current.filename)

  return (
    <Page
      title={d.title}
      lead={
        <span>
          <RowLink href={`/matters/${d.matter}/documents`}>
            {d.matterNumber} — {d.matterTitle}
          </RowLink>{' '}
          · version {d.currentVersion}
          {d.confidential && <> · <Badge tone="amber">confidential</Badge></>}
          {d.locked && <> · <Badge tone="red">locked</Badge></>}
          {d.legalHold && <> · <Badge tone="red">legal hold</Badge></>}
          {d.softDeletedAt && <> · <Badge tone="red">deleted</Badge></>}
        </span>
      }
    >
      <Notices searchParams={sp} />

      {d.softDeletedAt && (
        <Panel title="Deleted">
          <p>Deleted {fmtDateTime(d.softDeletedAt)}. Restore is window-bound.</p>
          <form action={restoreDocumentAction}>
            <input type="hidden" name="document" value={d.id} />
            <SubmitButton>Restore</SubmitButton>
          </form>
        </Panel>
      )}

      <Panel title="Versions">
        <DataTable
          headers={['Version', 'File', 'Size', 'Comment', 'By', 'When']}
          rows={detail.versions.map((v) => [
            `v${v.versionNo}`,
            <a key="dl" href={`/api/documents/${d.id}/download?version=${v.versionNo}`}>
              {v.filename}
            </a>,
            `${Math.max(1, Math.round(v.sizeBytes / 1024))} KB`,
            v.comment ?? '—',
            v.createdByName,
            fmtDateTime(v.createdAt),
          ])}
        />
        {office && (
          <p>
            <a href={office.href} className="text-sky-700 underline-offset-2 hover:underline">
              Open in {office.app}
            </a>{' '}
            — opens in your desktop Office app; saving there posts a new version here
            automatically.
          </p>
        )}
        {detail.versions.length >= 2 && (
          <p>
            <RowLink
              href={`/documents/${d.id}/compare?a=${detail.versions[1].versionNo}&b=${detail.versions[0].versionNo}`}
            >
              Compare the latest two versions
            </RowLink>
          </p>
        )}
        <form action={addVersionAction}>
          <input type="hidden" name="document" value={d.id} />
          <Field label="New version file">
            <input type="file" name="file" required />
          </Field>
          <Field label="Comment">
            <input type="text" name="comment" />
          </Field>
          <SubmitButton>Add version</SubmitButton>
        </form>
      </Panel>

      {ocrEligible && (
        <Panel title="Text recognition">
          <OcrPanel documentId={d.id} filename={current.filename} />
        </Panel>
      )}

      <Panel title="Checkout">
        {d.checkedOutBy ? (
          <>
            <p>
              Checked out by {d.checkedOutName}
              {d.checkoutPurpose ? ` — ${d.checkoutPurpose}` : ''}. Only the holder adds versions;
              checking in without a new version releases the hold.
            </p>
            <form action={checkinDocumentAction}>
              <input type="hidden" name="document" value={d.id} />
              <SubmitButton>Check in</SubmitButton>
            </form>
          </>
        ) : (
          <form action={checkoutDocumentAction}>
            <input type="hidden" name="document" value={d.id} />
            <Field label="Purpose">
              <input type="text" name="purpose" />
            </Field>
            <SubmitButton>Check out</SubmitButton>
          </form>
        )}
      </Panel>

      <Panel title="Details">
        <form action={editDocumentAction}>
          <input type="hidden" name="document" value={d.id} />
          <Field label="Title">
            <input type="text" name="title" defaultValue={d.title} required />
          </Field>
          <Field label="Description">
            <input type="text" name="description" defaultValue={d.description ?? ''} />
          </Field>
          <Field label="Document date">
            <input type="date" name="document_date" defaultValue={d.documentDate ?? ''} />
          </Field>
          <Field label="Confidential">
            <input type="checkbox" name="confidential" defaultChecked={d.confidential} />
          </Field>
          <SubmitButton>Save details</SubmitButton>
        </form>
      </Panel>

      <Panel title="Administration (documents.manage)">
        <form action={setDocumentLockAction}>
          <input type="hidden" name="document" value={d.id} />
          <input type="hidden" name="locked" value={d.locked ? 'false' : 'true'} />
          <SubmitButton>{d.locked ? 'Unlock' : 'Lock'}</SubmitButton>
        </form>
        <form action={setLegalHoldAction}>
          <input type="hidden" name="document" value={d.id} />
          <input type="hidden" name="hold" value={d.legalHold ? 'false' : 'true'} />
          <SubmitButton>{d.legalHold ? 'Release legal hold' : 'Set legal hold'}</SubmitButton>
        </form>
        {!d.softDeletedAt && (
          <form action={softDeleteDocumentAction}>
            <input type="hidden" name="document" value={d.id} />
            <input type="hidden" name="matter" value={d.matter} />
            <SubmitButton>Delete (soft)</SubmitButton>
          </form>
        )}
      </Panel>

      <Panel title="Share links">
        {detail.shares.length > 0 && (
          <DataTable
            headers={['Recipient', 'Views', 'Expires', 'Standing', '']}
            rows={detail.shares.map((s) => [
              s.recipient ?? '—',
              s.maxViews ? `${s.viewCount} of ${s.maxViews}` : String(s.viewCount),
              fmtDateTime(s.expiresAt),
              s.revoked ? <Badge key="r" tone="red">revoked</Badge> : 'live',
              s.revoked ? null : (
                <form key="x" action={revokeShareAction}>
                  <input type="hidden" name="document" value={d.id} />
                  <input type="hidden" name="share" value={s.id} />
                  <SubmitButton tone="danger">Revoke</SubmitButton>
                </form>
              ),
            ])}
          />
        )}
        <form action={createShareAction}>
          <input type="hidden" name="document" value={d.id} />
          <Field label="Recipient name">
            <input type="text" name="recipient_name" />
          </Field>
          <Field label="Recipient email">
            <input type="email" name="recipient_email" />
          </Field>
          <Field label="Expires after (days, default 14)">
            <input type="number" name="expires_days" min={1} />
          </Field>
          <Field label="View limit (blank = unlimited)">
            <input type="number" name="max_views" min={1} />
          </Field>
          <Field label="Password (optional)">
            <input type="text" name="password" />
          </Field>
          <Field label="Allow download">
            <input type="checkbox" name="allow_download" defaultChecked />
          </Field>
          <Field label="Watermark PDFs">
            <input type="checkbox" name="watermark" defaultChecked />
          </Field>
          <SubmitButton>Create share link — shown once</SubmitButton>
        </form>
      </Panel>

      <Panel title="Signature requests">
        {detail.signingRequests.length > 0 && (
          <DataTable
            headers={['Signer', 'Standing', 'Expires', 'Signed', '']}
            rows={detail.signingRequests.map((s) => [
              s.signer,
              s.status === 'signed' ? (
                <Badge key="s" tone="blue">signed</Badge>
              ) : s.status === 'revoked' ? (
                <Badge key="s" tone="red">revoked</Badge>
              ) : (
                'pending'
              ),
              fmtDateTime(s.expiresAt),
              s.signedDocument ? (
                <RowLink key="d" href={`/documents/${s.signedDocument}`}>
                  signed copy
                </RowLink>
              ) : (
                s.signedAt ? fmtDateTime(s.signedAt) : '—'
              ),
              s.status === 'pending' ? (
                <form key="x" action={revokeSigningRequestAction}>
                  <input type="hidden" name="document" value={d.id} />
                  <input type="hidden" name="request" value={s.id} />
                  <SubmitButton tone="danger">Revoke</SubmitButton>
                </form>
              ) : null,
            ])}
          />
        )}
        <form action={createSigningRequestAction}>
          <input type="hidden" name="document" value={d.id} />
          <Field label="Signer name">
            <input type="text" name="signer_name" required />
          </Field>
          <Field label="Signer email">
            <input type="email" name="signer_email" required />
          </Field>
          <Field label="Expires after (days, default 14)">
            <input type="number" name="expires_days" min={1} />
          </Field>
          <SubmitButton>Create signing link — shown once (PDF versions only)</SubmitButton>
        </form>
      </Panel>

      <Panel title="Access trail (latest 50)">
        <DataTable
          headers={['Who', 'Action', 'When']}
          rows={detail.access.map((a, i) => [
            `${a.actorKind} ${a.actor}`,
            a.action.replace(/_/g, ' '),
            fmtDateTime(a.occurredAt),
          ])}
        />
      </Panel>
    </Page>
  )
}
