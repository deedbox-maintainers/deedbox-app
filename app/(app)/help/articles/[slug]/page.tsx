// Help-article view: one published article — summary, steps,
// note, related links — with a plain-English permission hint when the
// feature it describes is gated.

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePrincipal } from '@/lib/auth'
import { articleBySlug } from '@/lib/reads/assistant'
import { Page, Panel, Badge } from '@/components/ui'

export default async function HelpArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const p = await requirePrincipal()
  const { slug } = await params
  const article = await articleBySlug(p, slug)
  if (!article) notFound()
  return (
    <Page
      title={article.title}
      lead={article.summary}
      actions={
        <Link
          href="/help/articles"
          className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
        >
          All articles
        </Link>
      }
    >
      <Panel>
        <div className="mb-3 flex flex-wrap gap-1.5">
          <Badge>{article.module}</Badge>
          {article.origin === 'firm' ? <Badge tone="blue">your firm</Badge> : null}
          {article.needsCapability ? (
            <Badge tone="amber">normally needs the {article.needsCapability} permission</Badge>
          ) : null}
        </div>
        {article.body ? (
          <p className="mb-3 whitespace-pre-wrap text-sm leading-relaxed text-neutral-800">
            {article.body}
          </p>
        ) : null}
        {article.steps.length > 0 ? (
          <ol className="mb-3 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-neutral-800">
            {article.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        ) : null}
        {article.warnings ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {article.warnings}
          </p>
        ) : null}
      </Panel>
      {article.related.length > 0 ? (
        <Panel title="Related">
          <div className="flex flex-wrap gap-2">
            {article.related.map((r) => (
              <Link
                key={r}
                href={`/help/articles/${r}`}
                className="rounded border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-600 hover:text-neutral-900"
              >
                {r}
              </Link>
            ))}
          </div>
        </Panel>
      ) : null}
    </Page>
  )
}
