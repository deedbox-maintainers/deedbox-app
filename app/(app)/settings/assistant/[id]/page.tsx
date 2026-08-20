// Firm help-article editor. Engine articles never reach this
// page — the read serves firm rows only.

import { notFound } from 'next/navigation'
import { requirePrincipal } from '@/lib/auth'
import { firmArticleForEdit, assistantAdmin } from '@/lib/reads/assistant'
import { Page, Panel, Badge, Notices } from '@/components/ui'
import { Field, TextInput, TextArea, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { updateArticleAction, articleStatusAction } from '../actions'

export default async function EditArticlePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const article = await firmArticleForEdit(p, Number(id))
  if (!article) notFound()
  const { capabilityKeys } = await assistantAdmin(p)
  return (
    <Page
      title={`Edit: ${article.title}`}
      lead={
        <>
          <span className="font-mono text-xs">{article.slug}</span> — the name is cited as a
          source and cannot change.
        </>
      }
      actions={
        article.status !== 'published' ? (
          <form action={articleStatusAction}>
            <input type="hidden" name="id" value={article.id} />
            <input type="hidden" name="status" value="published" />
            <input type="hidden" name="back" value={`/settings/assistant/${article.id}`} />
            <SubmitButton>Publish</SubmitButton>
          </form>
        ) : (
          <form action={articleStatusAction}>
            <input type="hidden" name="id" value={article.id} />
            <input type="hidden" name="status" value="retired" />
            <input type="hidden" name="back" value={`/settings/assistant/${article.id}`} />
            <SubmitButton tone="quiet">Retire</SubmitButton>
          </form>
        )
      }
    >
      <Notices searchParams={sp} />
      <Panel
        title={
          <>
            Article <Badge tone={article.status === 'published' ? 'green' : 'amber'}>{article.status}</Badge>
          </>
        }
      >
        <form action={updateArticleAction} className="max-w-2xl">
          <input type="hidden" name="id" value={article.id} />
          <Field label="Title">
            <TextInput name="title" required defaultValue={article.title} />
          </Field>
          <Field label="Summary">
            <TextInput name="summary" required defaultValue={article.summary} />
          </Field>
          <Field label="Module">
            <Select name="module" defaultValue={article.module}>
              {['general','matters','parties','billing','money','documents','email','portal','reports','security','configuration','imports'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </Select>
          </Field>
          <Field label="Steps (one per line)">
            <TextArea name="steps" rows={6} defaultValue={article.steps.join('\n')} />
          </Field>
          <Field label="Body (optional prose)">
            <TextArea name="body" rows={3} defaultValue={article.body} />
          </Field>
          <Field label="Note or warning (optional)">
            <TextInput name="warnings" defaultValue={article.warnings ?? ''} />
          </Field>
          <Field label="Routes (optional, space-separated)">
            <TextInput name="routes" defaultValue={article.routes.join(' ')} />
          </Field>
          <Field label="Needs permission (optional)">
            <Select name="needs_capability" defaultValue={article.needsCapability ?? ''}>
              <option value="">none</option>
              {capabilityKeys.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </Select>
          </Field>
          <SubmitButton>Save</SubmitButton>
        </form>
      </Panel>
    </Page>
  )
}
