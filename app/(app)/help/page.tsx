// Help home: a stateless chat over the persisted telemetry —
// the ask form posts to the pipeline and this page re-renders the
// conversation it was redirected to. Starters key off an optional
// from-route; the article browser stands even when no model is bound.

import Link from 'next/link'
import { requirePrincipal } from '@/lib/auth'
import { conversationThread } from '@/lib/reads/assistant'
import { starterQuestions } from '@/lib/ops/assistant'
import { Page, Panel, Badge, Notices, EmptyState } from '@/components/ui'
import { TextArea, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { askAction, feedbackAction } from './actions'

const CONFIDENCE_TONE: Record<string, 'green' | 'blue' | 'amber' | 'neutral'> = {
  high: 'green',
  medium: 'blue',
  low: 'amber',
  none: 'neutral',
}

export default async function HelpPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const conversationId = Number(sp.c ?? 0)
  const from = sp.from ?? ''
  const prefill = sp.q ?? ''
  const thread =
    conversationId > 0 ? await conversationThread(p, conversationId) : null
  const starters = starterQuestions(from || null)

  return (
    <Page
      title="Help"
      lead="Ask how to do something in the application. The assistant answers from the help articles, names its sources, and can never change anything."
      actions={
        <Link
          href="/help/articles"
          className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
        >
          Browse all help articles
        </Link>
      }
    >
      <Notices searchParams={sp} />

      {thread && thread.messages.length > 0 ? (
        <Panel title="This conversation">
          <div className="space-y-4">
            {thread.messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-neutral-900 px-3.5 py-2 text-sm text-white">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="max-w-full">
                  <div className="rounded-2xl rounded-bl-sm border border-neutral-200 bg-neutral-50 px-3.5 py-3">
                    <div className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-800">
                      {m.content}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-neutral-200 pt-2">
                      {m.confidence ? (
                        <Badge tone={CONFIDENCE_TONE[m.confidence] ?? 'neutral'}>
                          confidence: {m.confidence}
                        </Badge>
                      ) : null}
                      {m.wasRefusal ? <Badge tone="amber">declined</Badge> : null}
                      {m.retrievedSlugs.map((s) => (
                        <Link
                          key={s}
                          href={`/help/articles/${s}`}
                          className="rounded border border-neutral-200 bg-white px-1.5 py-0.5 text-[11px] text-neutral-500 hover:text-neutral-800"
                        >
                          {s}
                        </Link>
                      ))}
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1 pl-1">
                    {m.myRating ? (
                      <span className="text-[11px] text-neutral-400">
                        Thanks — you marked this “{m.myRating}”.
                      </span>
                    ) : (
                      (['up', 'down', 'wrong', 'needs_detail'] as const).map((r) => (
                        <form key={r} action={feedbackAction} className="inline">
                          <input type="hidden" name="message" value={m.id} />
                          <input type="hidden" name="conversation" value={thread.id} />
                          <input type="hidden" name="rating" value={r} />
                          <button
                            type="submit"
                            className="rounded border border-neutral-200 px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100"
                          >
                            {r === 'up'
                              ? 'Helpful'
                              : r === 'down'
                                ? 'Not helpful'
                                : r === 'wrong'
                                  ? 'Wrong'
                                  : 'More detail'}
                          </button>
                        </form>
                      ))
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        </Panel>
      ) : null}

      <Panel title={thread ? 'Ask a follow-up' : 'Ask a question'}>
        <form action={askAction}>
          <input type="hidden" name="conversation" value={thread?.id ?? ''} />
          <input type="hidden" name="from" value={from} />
          <TextArea
            name="question"
            rows={2}
            required
            defaultValue={prefill}
            placeholder="Ask how to do something…"
          />
          <div className="mt-2">
            <SubmitButton>Ask</SubmitButton>
          </div>
        </form>
        {!thread ? (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
              For example
            </p>
            <div className="flex flex-col gap-2">
              {starters.map((s) => (
                <Link
                  key={s}
                  href={`/help?q=${encodeURIComponent(s)}${from ? `&from=${encodeURIComponent(from)}` : ''}`}
                  className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
                >
                  {s}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
        {thread ? (
          <p className="mt-3 text-xs text-neutral-400">
            <Link href="/help" className="hover:underline">
              Start a new conversation
            </Link>
          </p>
        ) : null}
      </Panel>

      {!thread ? (
        <EmptyState>
          Answers come from the help articles only — the assistant never reads matters or
          clients, and it cannot make changes for you.
        </EmptyState>
      ) : null}
    </Page>
  )
}
