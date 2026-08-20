// Manual journal: up to eight lines; posts in one act.

import { requirePrincipal } from '@/lib/auth'
import { glChart } from '@/lib/reads/gl'
import { Page, Panel, Notices } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { manualJournalAction } from '../../actions'

export default async function NewJournalPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const { accounts } = await glChart(p)
  const active = (accounts as Record<string, unknown>[]).filter((a) => a.active)
  return (
    <Page title="New manual journal" lead="Debits must equal credits, above zero; it posts immediately with the next number.">
      <Notices searchParams={sp} />
      <Panel>
        <form action={manualJournalAction} className="max-w-3xl">
          <div className="flex flex-wrap gap-3">
            <Field label="Date"><TextInput name="journal_date" type="date" required /></Field>
            <Field label="Description"><TextInput name="description" required className="w-96" /></Field>
          </div>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-neutral-500">
                <th className="py-1">Account</th><th>Debit</th><th>Credit</th><th>Line note</th>
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <tr key={i}>
                  <td className="py-1 pr-2">
                    <Select name={`line_${i}_account`} defaultValue="">
                      <option value="">—</option>
                      {active.map((a) => (
                        <option key={a.id as number} value={a.id as number}>
                          {a.code as string} {a.name as string}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="pr-2"><TextInput name={`line_${i}_debit`} placeholder="0.00" className="w-28" /></td>
                  <td className="pr-2"><TextInput name={`line_${i}_credit`} placeholder="0.00" className="w-28" /></td>
                  <td><TextInput name={`line_${i}_description`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3">
            <SubmitButton>Post journal</SubmitButton>
          </div>
        </form>
      </Panel>
    </Page>
  )
}
