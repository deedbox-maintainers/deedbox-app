// Template manager: firm message templates editable with the token
// helper; pack templates read-only; rows whose superseded pack version is
// still pointed at by reminder steps flagged for re-pointing.

import { requirePrincipal } from '@/lib/auth'
import { templateManager } from '@/lib/reads/config'
import { TEMPLATE_PURPOSE_TOKENS } from '@/lib/ops/config'
import { Page, Panel, Badge, Notices, EmptyState } from '@/components/ui'
import { Field, TextInput, TextArea, Select, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { createTemplateAction, editTemplateAction, deactivateTemplateAction } from '../actions'

export default async function TemplatesPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const templates = await templateManager(p)
  return (
    <Page
      title="Message templates"
      lead="The wording of reminders, statements and notices. Tokens are validated against each purpose's catalogue — an unknown token refuses by name."
    >
      <Notices searchParams={sp} />
      <Panel title="Templates">
        {templates.length === 0 ? (
          <EmptyState>No templates yet — the shipped and pack rows appear here.</EmptyState>
        ) : (
          <div className="divide-y divide-neutral-100">
            {templates.map((t) => (
              <details key={t.id} className="py-2 text-sm">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                  <span className={t.active ? 'font-medium text-neutral-800' : 'text-neutral-400 line-through'}>
                    {t.name}
                  </span>
                  <Badge tone="blue">{t.channel}</Badge>
                  <Badge tone="neutral">{t.purpose}</Badge>
                  {t.pack_version ? <Badge tone="violet">pack {t.pack_version_label}</Badge> : null}
                  {t.superseded_pack && t.reminder_steps > 0 ? (
                    <Badge tone="amber">superseded pack version — re-point {t.reminder_steps} reminder step(s)</Badge>
                  ) : null}
                </summary>
                {t.pack_version ? (
                  <pre className="mt-2 overflow-x-auto rounded bg-neutral-50 p-2 text-xs text-neutral-600">
                    {t.subject ? `Subject: ${t.subject}\n` : ''}
                    {t.body}
                  </pre>
                ) : (
                  <form action={editTemplateAction} className="mt-2 max-w-2xl">
                    <input type="hidden" name="template" value={t.id} />
                    <Field label="Name">
                      <TextInput name="name" defaultValue={t.name} />
                    </Field>
                    {t.channel === 'email' ? (
                      <Field label="Subject">
                        <TextInput name="subject" defaultValue={t.subject ?? ''} />
                      </Field>
                    ) : null}
                    <Field
                      label="Body"
                      hint={`Tokens for ${t.purpose}: ${(TEMPLATE_PURPOSE_TOKENS[t.purpose] ?? []).map((k) => `{{${k}}}`).join(' ')}`}
                    >
                      <TextArea name="body" defaultValue={t.body} rows={5} />
                    </Field>
                    <div className="flex gap-2">
                      <SubmitButton tone="quiet">Save</SubmitButton>
                    </div>
                  </form>
                )}
                {!t.pack_version && t.active ? (
                  <div className="mt-2">
                    <InlineAction
                      action={deactivateTemplateAction}
                      fields={{ template: t.id }}
                      label="Deactivate"
                      tone="danger"
                    />
                  </div>
                ) : null}
              </details>
            ))}
          </div>
        )}
      </Panel>
      <Panel title="Create a template">
        <form action={createTemplateAction} className="max-w-2xl">
          <div className="grid grid-cols-3 gap-x-4">
            <Field label="Name">
              <TextInput name="name" required />
            </Field>
            <Field label="Channel">
              <Select name="channel">
                <option value="email">Email</option>
                <option value="text_message">Text message</option>
                <option value="task">Task</option>
              </Select>
            </Field>
            <Field label="Purpose">
              <Select name="purpose">
                {Object.keys(TEMPLATE_PURPOSE_TOKENS).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Subject (email only)">
            <TextInput name="subject" />
          </Field>
          <Field label="Body" hint="Tokens per purpose are listed once a purpose is chosen; unknown tokens refuse by name.">
            <TextArea name="body" rows={5} required />
          </Field>
          <SubmitButton>Create</SubmitButton>
        </form>
      </Panel>
    </Page>
  )
}
