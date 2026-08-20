// Assistant administration: the knowledge base in every status (engine
// articles read-only), a new-article form, the knowledge-gap queue and
// recent answer feedback. Gated assistant.manage by its read.

import Link from 'next/link'
import { requirePrincipal } from '@/lib/auth'
import { assistantAdmin } from '@/lib/reads/assistant'
import { Page, Panel, Badge, Notices, DataTable, fmtDateTime } from '@/components/ui'
import { Field, TextInput, TextArea, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { createArticleAction, articleStatusAction, gapAction } from './actions'

const STATUS_TONE: Record<string, 'green' | 'amber' | 'neutral'> = {
  published: 'green',
  draft: 'amber',
  retired: 'neutral',
}

export default async function AssistantAdminPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const data = await assistantAdmin(p)
  return (
    <Page
      title="Help articles"
      lead="What the help assistant knows. Built-in articles ship with the application and are replaced by upgrades; your firm's own articles are authored here and searchable once published."
    >
      <Notices searchParams={sp} />

      <Panel title="Articles">
        <DataTable
          headers={['Title', 'Name', 'Module', 'Origin', 'Status', '']}
          rows={data.articles.map((a) => [
            a.title,
            <span key="s" className="font-mono text-xs">{a.slug}</span>,
            a.module,
            a.origin === 'engine' ? (
              <Badge key="o" tone="violet">built-in</Badge>
            ) : (
              <Badge key="o" tone="blue">your firm</Badge>
            ),
            <Badge key="st" tone={STATUS_TONE[a.status] ?? 'neutral'}>{a.status}</Badge>,
            a.origin === 'firm' ? (
              <span key="a" className="flex items-center gap-1.5">
                <Link
                  href={`/settings/assistant/${a.id}`}
                  className="text-xs text-sky-700 hover:underline"
                >
                  Edit
                </Link>
                {a.status !== 'published' ? (
                  <form action={articleStatusAction} className="inline">
                    <input type="hidden" name="id" value={a.id} />
                    <input type="hidden" name="status" value="published" />
                    <SubmitButton tone="quiet">Publish</SubmitButton>
                  </form>
                ) : (
                  <form action={articleStatusAction} className="inline">
                    <input type="hidden" name="id" value={a.id} />
                    <input type="hidden" name="status" value="retired" />
                    <SubmitButton tone="quiet">Retire</SubmitButton>
                  </form>
                )}
              </span>
            ) : (
              <span key="a" className="text-xs text-neutral-400">read-only</span>
            ),
          ])}
          emptyState="No articles yet."
        />
      </Panel>

      <Panel title="New firm article">
        <form action={createArticleAction} className="max-w-2xl">
          <Field label="Name (lowercase-with-hyphens)" hint="Cited as the source of answers; cannot change later.">
            <TextInput name="slug" required placeholder="our-costs-agreements" />
          </Field>
          <Field label="Title">
            <TextInput name="title" required />
          </Field>
          <Field label="Summary" hint="One or two sentences; searched and shown in lists.">
            <TextInput name="summary" required />
          </Field>
          <Field label="Module">
            <Select name="module" defaultValue="general">
              {['general','matters','parties','billing','money','documents','email','portal','reports','security','configuration','imports'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </Select>
          </Field>
          <Field label="Steps (one per line)">
            <TextArea name="steps" rows={5} />
          </Field>
          <Field label="Body (optional prose)">
            <TextArea name="body" rows={3} />
          </Field>
          <Field label="Note or warning (optional)">
            <TextInput name="warnings" />
          </Field>
          <Field label="Routes (optional, space-separated)" hint="Screens this article is about, like /matters/:id — boosts retrieval there.">
            <TextInput name="routes" />
          </Field>
          <Field label="Needs permission (optional)" hint="If the feature is gated, answers warn people whose role lacks it.">
            <Select name="needs_capability" defaultValue="">
              <option value="">none</option>
              {data.capabilityKeys.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </Select>
          </Field>
          <SubmitButton>Create draft</SubmitButton>
        </form>
      </Panel>

      <Panel title="Knowledge gaps">
        <p className="mb-2 text-xs text-neutral-500">
          Questions the assistant could not answer confidently. Write or extend an article, then
          mark the gap resolved.
        </p>
        <DataTable
          headers={['Question', 'Confidence', 'Where', 'When', 'Status', '']}
          rows={data.gaps.map((g) => [
            g.question,
            g.confidence ?? '—',
            g.route ?? '—',
            fmtDateTime(g.createdAt),
            <Badge key="s" tone={g.status === 'open' ? 'amber' : 'neutral'}>{g.status}</Badge>,
            g.status !== 'resolved' ? (
              <span key="a" className="flex items-center gap-1.5">
                {g.status === 'open' ? (
                  <form action={gapAction} className="inline">
                    <input type="hidden" name="id" value={g.id} />
                    <input type="hidden" name="status" value="reviewed" />
                    <SubmitButton tone="quiet">Reviewed</SubmitButton>
                  </form>
                ) : null}
                <form action={gapAction} className="inline">
                  <input type="hidden" name="id" value={g.id} />
                  <input type="hidden" name="status" value="resolved" />
                  <SubmitButton tone="quiet">Resolved</SubmitButton>
                </form>
              </span>
            ) : (
              <span key="a" />
            ),
          ])}
          emptyState="No gaps recorded — every question so far found its answer."
        />
      </Panel>

      <Panel title="Recent answer feedback">
        <DataTable
          headers={['Rating', 'Answer (excerpt)', 'Note', 'When']}
          rows={data.feedback.map((f) => [
            <Badge
              key="r"
              tone={f.rating === 'up' ? 'green' : f.rating === 'wrong' ? 'red' : 'amber'}
            >
              {f.rating}
            </Badge>,
            <span key="e" className="text-xs text-neutral-600">{f.answerExcerpt}…</span>,
            f.note ?? '—',
            fmtDateTime(f.createdAt),
          ])}
          emptyState="No feedback yet."
        />
      </Panel>
    </Page>
  )
}
