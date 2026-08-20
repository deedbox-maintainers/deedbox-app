// Numbering console: one card per purpose/scope — pattern, mode, reset,
// next-number preview per partition, format history, replace flow. A
// replacement never renumbers and never restarts a series.

import { requirePrincipal } from '@/lib/auth'
import { numberingConsole } from '@/lib/reads/config'
import { Page, Panel, Badge, Notices, fmtDateTime } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { replaceFormat } from '../actions'

export default async function NumberingPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const formats = await numberingConsole(p)
  const active = formats.filter((f) => f.active)
  const history = formats.filter((f) => !f.active)
  return (
    <Page
      title="Numbering"
      lead="Every numbered document draws from these formats. Gapless series can never skip or repeat a committed number; replacing a format changes future numbers only and the series continues where it stood."
    >
      <Notices searchParams={sp} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {active.map((f) => (
          <Panel
            key={f.id}
            title={
              <>
                {f.purpose}
                {f.scope ? ` · ${f.scope}` : ''}{' '}
                <Badge tone={f.allocation_mode === 'gapless' ? 'green' : 'blue'}>{f.allocation_mode}</Badge>
                {f.reset === 'yearly' ? <Badge tone="neutral">yearly reset</Badge> : f.reset === 'daily' ? <Badge tone="neutral">daily reset</Badge> : null}
              </>
            }
          >
            <p className="mb-2 text-sm">
              Pattern: <code className="rounded bg-neutral-100 px-1">{f.pattern}</code>
            </p>
            {(f.partitions as { partition: string; next: number }[]).length > 0 ? (
              <p className="mb-3 text-xs text-neutral-500">
                Next number{' '}
                {(f.partitions as { partition: string; next: number }[])
                  .map((pt) => `${pt.partition ? `${pt.partition}: ` : ''}${pt.next}`)
                  .join(' · ')}
              </p>
            ) : (
              <p className="mb-3 text-xs text-neutral-400">
                {f.allocation_mode === 'gapless' ? 'Nothing allocated yet — starts at 1.' : 'Sequence mode.'}
              </p>
            )}
            <details>
              <summary className="cursor-pointer text-xs text-neutral-500">Replace this format</summary>
              <form action={replaceFormat} className="mt-2">
                <input type="hidden" name="purpose" value={f.purpose} />
                <input type="hidden" name="scope" value={f.scope ?? ''} />
                <Field label="New pattern" hint="Tokens: {SEQ:n} (required), {YEAR} (required for yearly reset), {DATE} (required for daily reset), {OFFICE}.">
                  <TextInput name="pattern" defaultValue={f.pattern} required />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Mode" hint="Gapless: no committed gaps, ever.">
                    <Select name="allocation_mode" defaultValue={f.allocation_mode}>
                      <option value="gapless">gapless</option>
                      <option value="sequence">sequence</option>
                    </Select>
                  </Field>
                  <Field label="Reset">
                    <Select name="reset" defaultValue={f.reset}>
                      <option value="never">never</option>
                      <option value="yearly">yearly</option>
                      <option value="daily">daily</option>
                    </Select>
                  </Field>
                </div>
                <SubmitButton tone="quiet">Replace</SubmitButton>
              </form>
            </details>
          </Panel>
        ))}
      </div>
      {history.length > 0 ? (
        <Panel title="Superseded formats">
          <ul className="space-y-1 text-sm text-neutral-500">
            {history.map((f) => (
              <li key={f.id}>
                {f.purpose}
                {f.scope ? ` · ${f.scope}` : ''} — <code>{f.pattern}</code> ({f.allocation_mode},{' '}
                {String(f.reset)}; created {fmtDateTime(f.created_at)})
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </Page>
  )
}
