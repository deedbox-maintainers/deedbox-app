// Help-article browser: the published knowledge base grouped by module —
// engine and this firm's own articles together. Stands whether or not any
// model is bound.

import Link from 'next/link'
import { requirePrincipal } from '@/lib/auth'
import { publishedArticles } from '@/lib/reads/assistant'
import { Page, Panel, Badge, EmptyState } from '@/components/ui'

export default async function HelpArticlesPage() {
  const p = await requirePrincipal()
  const articles = await publishedArticles(p)
  const modules = [...new Set(articles.map((a) => a.module))]
  return (
    <Page
      title="Help articles"
      lead="Everything the assistant knows. Built-in articles describe the application; your firm can add its own under Configuration."
      actions={
        <Link
          href="/help"
          className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
        >
          Ask the assistant
        </Link>
      }
    >
      {articles.length === 0 ? <EmptyState>No published help articles yet.</EmptyState> : null}
      {modules.map((mod) => (
        <Panel key={mod} title={mod}>
          <div className="divide-y divide-neutral-100">
            {articles
              .filter((a) => a.module === mod)
              .map((a) => (
                <div key={a.id} className="flex items-start gap-3 py-2">
                  <div className="min-w-0 grow">
                    <Link
                      href={`/help/articles/${a.slug}`}
                      className="text-sm font-medium text-neutral-800 hover:underline"
                    >
                      {a.title}
                    </Link>
                    <p className="text-xs text-neutral-500">{a.summary}</p>
                  </div>
                  {a.origin === 'firm' ? <Badge tone="blue">your firm</Badge> : null}
                </div>
              ))}
          </div>
        </Panel>
      ))}
    </Page>
  )
}
