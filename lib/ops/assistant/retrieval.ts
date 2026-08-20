// Assistant retrieval: the fixed, parameterised call to
// deedbox.assistant_search (full-text rank + trigram fuzziness + route
// boost) and the honest confidence floor built on its outputs. The model
// never emits SQL; relevance is gated on `matched` — whether the full-text
// query actually hit — never on the route boost, which must not
// manufacture confidence on off-topic questions.

import type { Tx } from '@/lib/db'

// A strong fuzzy title match (typo tolerance) also counts as a hit.
const STRONG_FUZZY = 0.9
// With OR-of-terms matching, a strong direct hit scores well above a
// shared-word tangent; this threshold separates the two.
const HIGH_LEX = 5.0

export type Confidence = 'high' | 'medium' | 'low' | 'none'

export interface RetrievedChunk {
  chunkId: number
  articleId: number
  slug: string
  title: string
  module: string
  needsCapability: string | null
  heading: string | null
  content: string
  routes: string[]
  score: number
  lex: number
  matched: boolean
}

export async function searchHelpInTx(
  tx: Tx,
  firm: number,
  question: string,
  route: string | null,
  limit = 8,
): Promise<RetrievedChunk[]> {
  const r = await tx.query(
    `select * from deedbox.assistant_search($1, $2, $3, $4)`,
    [firm, question, route, limit],
  )
  return (r.rows as Record<string, unknown>[])
    .map((row) => ({
      chunkId: row.chunk_id as number,
      articleId: row.article_id as number,
      slug: row.slug as string,
      title: row.title as string,
      module: row.module as string,
      needsCapability: (row.needs_capability as string | null) ?? null,
      heading: (row.heading as string | null) ?? null,
      content: row.content as string,
      routes: (row.routes as string[]) ?? [],
      score: Number(row.score),
      lex: Number(row.lex),
      matched: row.matched === true,
    }))
    // Keep only genuine hits: a real keyword match, or a strong fuzzy/title
    // match. Route-only rows are dropped so they can never answer.
    .filter((c) => c.matched || c.lex >= STRONG_FUZZY)
}

export function confidenceFor(chunks: RetrievedChunk[]): Confidence {
  if (chunks.length === 0) return 'none'
  const matched = chunks.filter((c) => c.matched)
  if (matched.some((c) => c.lex >= HIGH_LEX)) return 'high'
  if (matched.length > 0) return 'medium'
  return 'low' // only fuzzy/title matches — usable but weak
}

/** Retrieved chunks as a clearly-delimited, read-only reference block. */
export function renderSources(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '(no matching help articles were found)'
  return chunks
    .map(
      (c, i) =>
        `[${i + 1}] source_slug=${c.slug} | article="${c.title}"${c.heading ? ` | section="${c.heading}"` : ''}\n${c.content}`,
    )
    .join('\n\n')
}

/** De-duped source list (slug + title) for the answer footer and the log. */
export function distinctSources(chunks: RetrievedChunk[]): { slug: string; title: string }[] {
  const seen = new Set<string>()
  const out: { slug: string; title: string }[] = []
  for (const c of chunks) {
    if (seen.has(c.slug)) continue
    seen.add(c.slug)
    out.push({ slug: c.slug, title: c.title })
  }
  return out
}
