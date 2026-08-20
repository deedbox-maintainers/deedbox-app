// Version compare: a dependency-free line diff of two versions'
// extracted texts. Lines only — the evidence-grade record is the versions
// themselves; this is a reading aid.

import { requirePrincipal } from '@/lib/auth'
import { compareVersions } from '@/lib/reads/documents'
import { Page, Panel, RowLink } from '@/components/ui'
import type { SearchParams } from '@/lib/screens/action'

type Op = { kind: 'same' | 'removed' | 'added'; line: string }

/** A small LCS line diff, capped for sanity. */
function diffLines(aText: string, bText: string): Op[] {
  const a = aText.split(/\r?\n/).slice(0, 2000)
  const b = bText.split(/\r?\n/).slice(0, 2000)
  const m = a.length
  const n = b.length
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', line: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: 'removed', line: a[i] })
      i++
    } else {
      ops.push({ kind: 'added', line: b[j] })
      j++
    }
  }
  while (i < m) ops.push({ kind: 'removed', line: a[i++] })
  while (j < n) ops.push({ kind: 'added', line: b[j++] })
  return ops
}

export default async function ComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await searchParams
  const a = Number(sp.a ?? 1)
  const b = Number(sp.b ?? 2)
  const cmp = await compareVersions(p, Number(id), a, b)

  const ready = cmp.a && cmp.b && cmp.a.method !== 'pending' && cmp.b.method !== 'pending'
  const ops = ready ? diffLines(cmp.a!.text, cmp.b!.text) : []
  const colour = (k: Op['kind']) =>
    k === 'added' ? '#dcfce7' : k === 'removed' ? '#fee2e2' : 'transparent'
  const prefix = (k: Op['kind']) => (k === 'added' ? '+ ' : k === 'removed' ? '− ' : '  ')

  return (
    <Page
      title={`Compare — ${cmp.document.title}`}
      lead={
        <span>
          <RowLink href={`/documents/${cmp.document.id}`}>back to the document</RowLink> — version{' '}
          {a} against version {b}, from each version&apos;s extracted text.
        </span>
      }
    >
      <Panel title={`v${a} → v${b}`}>
        {!cmp.a || !cmp.b ? (
          <p>One of those versions does not exist.</p>
        ) : !ready ? (
          <p>Text extraction has not run for one of these versions yet — the sweep covers it shortly.</p>
        ) : (
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem', lineHeight: 1.5 }}>
            {ops.map((op, idx) => (
              <span key={idx} style={{ display: 'block', background: colour(op.kind) }}>
                {prefix(op.kind)}
                {op.line}
              </span>
            ))}
          </pre>
        )}
      </Panel>
    </Page>
  )
}
