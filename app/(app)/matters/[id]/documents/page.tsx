// The matter documents tab: folders, the document list, upload,
// and the unfiled arrivals from the intake door's landing table — each
// filed into a document head with one action. Sharing, signing, templates
// and full-text search arrive with their own slices.

import { requirePrincipal } from '@/lib/auth'
import { matterDocumentsTab, activeDocumentTemplates } from '@/lib/reads/documents'
import { matterFilingAddress } from '@/lib/reads/m365'
import { ensureFilingTokenAction } from '../../actions'
import { Page, Panel, DataTable, Notices, RowLink, Badge } from '@/components/ui'
import { Field, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  uploadDocumentAction,
  fileArrivalAction,
  createFolderAction,
  renameFolderAction,
  deleteFolderAction,
  generateFromTemplateAction,
} from '../../../documents/actions'

function fmtSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

export default async function MatterDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const tab = await matterDocumentsTab(p, Number(id))
  const templates = await activeDocumentTemplates(p)
  const folderName = new Map<number, string>(tab.folders.map((f) => [f.id, f.name]))
  const filing = await matterFilingAddress(p, tab.matter.id)

  return (
    <Page
      title={`Documents — ${tab.matter.matterNumber}`}
      lead={
        <span>
          {tab.matter.title} — <RowLink href={`/matters/${tab.matter.id}`}>back to the matter</RowLink>.
          Files live on the platform store; every version is permanent evidence, and access is
          recorded.
        </span>
      }
    >
      <Notices searchParams={sp} />

      {tab.arrivals.length > 0 && (
        <Panel title="Unfiled arrivals">
          <DataTable
            headers={['File', 'Size', 'Arrived via', 'File it']}
            rows={tab.arrivals.map((a) => [
              a.filename,
              fmtSize(a.sizeBytes),
              a.source.replace(/_/g, ' '),
              <form key={a.id} action={fileArrivalAction}>
                <input type="hidden" name="matter" value={tab.matter.id} />
                <input type="hidden" name="file" value={a.id} />
                <SubmitButton>File as document</SubmitButton>
              </form>,
            ])}
          />
        </Panel>
      )}

      <Panel title="Documents">
        <DataTable
          headers={['Title', 'Folder', 'Version', 'File', 'Size', 'Standing']}
          rows={tab.documents.map((d) => [
            <RowLink key="t" href={`/documents/${d.id}`}>{d.title}</RowLink>,
            d.folder ? folderName.get(d.folder) ?? '—' : '—',
            `v${d.currentVersion}`,
            <a key="f" href={`/api/documents/${d.id}/download`}>{d.filename}</a>,
            fmtSize(d.sizeBytes),
            <span key="s">
              {d.confidential && <Badge tone="amber">confidential</Badge>}{' '}
              {d.locked && <Badge tone="red">locked</Badge>}{' '}
              {d.legalHold && <Badge tone="red">legal hold</Badge>}{' '}
              {d.checkedOutBy && <Badge tone="blue">out: {d.checkedOutName}</Badge>}
            </span>,
          ])}
        />
      </Panel>

      {templates.length > 0 && tab.matter.status !== 'closed' && tab.matter.status !== 'archived' && (
        <Panel title="Generate from template">
          <form action={generateFromTemplateAction}>
            <input type="hidden" name="matter" value={tab.matter.id} />
            <Field label="Template">
              <select name="template" required defaultValue="">
                <option value="" disabled>
                  Choose a template
                </option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.category} — {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <SubmitButton>Generate document</SubmitButton>
          </form>
        </Panel>
      )}

      <Panel title="Upload a document">
        <form action={uploadDocumentAction}>
          <input type="hidden" name="matter" value={tab.matter.id} />
          <Field label="File">
            <input type="file" name="file" required multiple />
          </Field>
          <Field label="Title (defaults to the file name)">
            <input type="text" name="title" />
          </Field>
          <Field label="Folder">
            <select name="folder" defaultValue="">
              <option value="">Matter root</option>
              {tab.folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Description">
            <input type="text" name="description" />
          </Field>
          <Field label="Confidential">
            <input type="checkbox" name="confidential" />
          </Field>
          <SubmitButton>Upload</SubmitButton>
        </form>
      </Panel>

      {filing.configured && (
        <Panel title="Email filing">
          {filing.address ? (
            <p className="text-sm">
              Forward or copy mail to <strong>{filing.address}</strong> and the message and its
              attachments file themselves onto this matter as documents (checked every few
              minutes; unrecognised mail stays unread in the shared mailbox for a person).
            </p>
          ) : (
            <form action={ensureFilingTokenAction}>
              <input type="hidden" name="matter" value={tab.matter.id} />
              <p className="text-sm">
                This matter has no email filing address yet — create one and any mail copied to
                it will file itself here.
              </p>
              <SubmitButton>Create the filing address</SubmitButton>
            </form>
          )}
        </Panel>
      )}

      <Panel title="Folders">
        <DataTable
          headers={['Folder', 'Parent', 'Rename', 'Delete (empty only)']}
          rows={tab.folders.map((f) => [
            f.name,
            f.parent ? folderName.get(f.parent) ?? '—' : '—',
            <form key={`r${f.id}`} action={renameFolderAction} className="flex items-center gap-1">
              <input type="hidden" name="matter" value={tab.matter.id} />
              <input type="hidden" name="folder" value={f.id} />
              <input type="text" name="name" defaultValue={f.name} className="w-36 rounded-md border border-neutral-300 px-2 py-1 text-sm" />
              <SubmitButton tone="quiet">Rename</SubmitButton>
            </form>,
            <form key={f.id} action={deleteFolderAction}>
              <input type="hidden" name="matter" value={tab.matter.id} />
              <input type="hidden" name="folder" value={f.id} />
              <SubmitButton>Delete</SubmitButton>
            </form>,
          ])}
        />
        <form action={createFolderAction}>
          <input type="hidden" name="matter" value={tab.matter.id} />
          <Field label="New folder">
            <input type="text" name="name" required />
          </Field>
          <Field label="Inside">
            <select name="parent" defaultValue="">
              <option value="">Matter root</option>
              {tab.folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
          <SubmitButton>Create folder</SubmitButton>
        </form>
      </Panel>
    </Page>
  )
}
