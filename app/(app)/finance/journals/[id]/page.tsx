// Journal view: the lines, and the one lawful mutation.

import { notFound } from 'next/navigation'
import { requirePrincipal } from '@/lib/auth'
import { glJournalView } from '@/lib/reads/gl'
import { Page, Panel, Badge, Notices, DataTable, DetailList, fmtDate } from '@/components/ui'
import { SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { reverseJournalAction } from '../../actions'

export default async function JournalViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const v = await glJournalView(p, Number(id))
  if (!v) notFound()
  const j = v.journal as Record<string, unknown>
  return (
    <Page
      title={`Journal ${(j.journal_no as string) ?? `draft ${j.id}`}`}
      lead={j.description as string}
      actions={
        j.status === 'posted' ? (
          <form action={reverseJournalAction}>
            <input type="hidden" name="id" value={j.id as number} />
            <SubmitButton tone="danger">Reverse</SubmitButton>
          </form>
        ) : undefined
      }
    >
      <Notices searchParams={sp} />
      <Panel>
        <DetailList
          items={[
            ['Date', fmtDate(j.journal_date)],
            ['Source', j.source_type as string],
            ['Status', <Badge key="s" tone={j.status === 'posted' ? 'green' : 'neutral'}>{j.status as string}</Badge>],
            ...(j.source_ref ? ([['Source reference', j.source_ref as string]] as [React.ReactNode, React.ReactNode][]) : []),
          ]}
        />
      </Panel>
      <Panel title="Lines">
        <DataTable
          headers={['#', 'Account', 'Debit', 'Credit', 'Note', 'Tax']}
          rows={(v.lines as Record<string, unknown>[]).map((l) => [
            l.line_no as number,
            `${l.code as string} ${l.account_name as string}`,
            <span key="d" className="tabular-nums">{Number(l.debit) ? Number(l.debit).toFixed(2) : ''}</span>,
            <span key="c" className="tabular-nums">{Number(l.credit) ? Number(l.credit).toFixed(2) : ''}</span>,
            (l.description as string | null) ?? '',
            (l.tax_code_label as string | null) ?? '',
          ])}
        />
      </Panel>
    </Page>
  )
}
