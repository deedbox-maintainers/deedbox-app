// Reminder configuration: sequences and steps (reminders.manage), the
// configuration domain's templates shown read-only, the default flag.

import { requirePrincipal } from '@/lib/auth'
import { reminderConfig } from '@/lib/reads/billing'
import { Page, Panel, DataTable, Notices, Badge, EmptyState } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton, Checkbox } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { createSequenceAction } from '../actions'

export default async function RemindersConfigPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const cfg = await reminderConfig(p)

  return (
    <Page
      title="Reminder sequences"
      lead="What happens to an unpaid bill, step by step. A bill follows its sequence until paid, disputed, arranged, held, or the steps run out — then it waits on the unpaid register for a person."
    >
      <Notices searchParams={sp} />

      <Panel title="Sequences">
        {cfg.sequences.length === 0 ? (
          <EmptyState>No sequences — the shipped default arrives with the pack, or create one below.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {cfg.sequences.map((s) => (
              <li key={s.id as number} className="rounded-md border border-neutral-200 p-3 text-sm">
                <p className="mb-1 font-medium">
                  {String(s.name)}{' '}
                  {s.default_for_new_bills ? <Badge tone="blue">default for new bills</Badge> : null}
                  {!s.active ? <Badge tone="neutral">inactive</Badge> : null}
                </p>
                <DataTable
                  headers={['Step', 'Days after previous', 'Channel', 'Template']}
                  rows={cfg.steps
                    .filter((st) => st.sequence === s.id)
                    .map((st) => [
                      String(st.step_no),
                      String(st.days_after_previous),
                      String(st.channel).replace('_', ' '),
                      String(
                        cfg.templates.find((t) => t.id === st.template)?.name ?? `#${st.template}`,
                      ),
                    ])}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {cfg.mayManage ? (
        <Panel title="New sequence">
          <form action={createSequenceAction} className="max-w-lg">
            <Field label="Name">
              <TextInput name="name" required />
            </Field>
            <Checkbox name="default_for_new_bills" label="Make this the default for newly issued bills" />
            <p className="mb-1 text-sm font-medium text-neutral-700">Steps</p>
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="grid grid-cols-4 gap-2">
                <Field label={`Step ${n}`}>
                  <TextInput name="step_no" defaultValue={String(n)} inputMode="numeric" />
                </Field>
                <Field label="Days after">
                  <TextInput name="step_days" inputMode="numeric" />
                </Field>
                <Field label="Channel">
                  <Select name="step_channel" defaultValue="email">
                    <option value="email">Email</option>
                    <option value="text_message">Text</option>
                    <option value="task">Task for staff</option>
                  </Select>
                </Field>
                <Field label="Template">
                  <Select name="step_template" defaultValue="">
                    <option value="">—</option>
                    {cfg.templates.map((t) => (
                      <option key={t.id as number} value={t.id as number}>
                        {String(t.name)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            ))}
            <p className="mb-2 text-xs text-neutral-400">
              Rows without a template are ignored. Template wording is edited under Configuration →
              Templates (templates.manage) — read-only here by design.
            </p>
            <SubmitButton>Create sequence</SubmitButton>
          </form>
        </Panel>
      ) : (
        <p className="text-sm text-neutral-500">Editing sequences needs reminders.manage.</p>
      )}
    </Page>
  )
}
