// Document templates administration: upload Word templates with
// merge fields, activate/deactivate, edit metadata, soft delete. Writes are
// gated on templates.manage inside the operations. Message templates keep
// their own screen at /settings/templates.

import { requirePrincipal } from '@/lib/auth'
import { documentTemplatesList } from '@/lib/reads/documents'
import { Page, Panel, DataTable, Notices, Badge } from '@/components/ui'
import { Field, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  uploadDocumentTemplateAction,
  setTemplateActiveAction,
  deleteDocumentTemplateAction,
} from '../../documents/actions'

export default async function DocumentTemplatesPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const templates = await documentTemplatesList(p)

  return (
    <Page
      title="Document templates"
      lead={
        <span>
          Word templates with merge fields, generated onto matters as documents. Tags use the
          honest vocabulary (Matter.Summary, Matter.ResponsibleLawyer.Name,
          Matter.Client.Address.Postcode); lowercase spellings also render. Only an
          active template generates.
        </span>
      }
    >
      <Notices searchParams={sp} />

      <Panel title="Templates">
        <DataTable
          headers={['Name', 'Category', 'Area', 'Jurisdiction', 'File', 'Standing', 'Actions']}
          rows={templates.map((t) => [
            t.name,
            t.category,
            t.practiceAreaName ?? '—',
            t.jurisdiction ?? '—',
            t.filename,
            t.active ? <Badge key="a" tone="blue">active</Badge> : 'inactive',
            <span key="x" style={{ display: 'flex', gap: '0.5rem' }}>
              <form action={setTemplateActiveAction}>
                <input type="hidden" name="template" value={t.id} />
                <input type="hidden" name="active" value={t.active ? 'false' : 'true'} />
                <SubmitButton>{t.active ? 'Deactivate' : 'Activate'}</SubmitButton>
              </form>
              <form action={deleteDocumentTemplateAction}>
                <input type="hidden" name="template" value={t.id} />
                <SubmitButton tone="danger">Delete</SubmitButton>
              </form>
            </span>,
          ])}
        />
      </Panel>

      <Panel title="Upload a template">
        <form action={uploadDocumentTemplateAction}>
          <Field label="Template file (.docx with merge fields)">
            <input type="file" name="file" accept=".docx" required />
          </Field>
          <Field label="Name">
            <input type="text" name="name" required />
          </Field>
          <Field label="Category">
            <input type="text" name="category" placeholder="General" />
          </Field>
          <Field label="Description">
            <input type="text" name="description" />
          </Field>
          <Field label="Jurisdiction">
            <input type="text" name="jurisdiction" />
          </Field>
          <SubmitButton>Upload template</SubmitButton>
        </form>
      </Panel>
    </Page>
  )
}
