// Assistant reads: the help page's conversation thread (own conversations
// only), the published knowledge base for browsing, and the
// administration screen's data (articles in every status, the gap queue,
// recent feedback) — the admin read checks assistant.manage itself.

import type { Principal } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { hasCapability } from '@/lib/ops/shared'

export interface ThreadMessage {
  id: number
  role: string
  content: string
  confidence: string | null
  wasRefusal: boolean
  retrievedSlugs: string[]
  createdAt: string
  myRating: string | null
}

export async function conversationThread(
  p: Principal,
  conversationId: number,
): Promise<{ id: number; messages: ThreadMessage[] } | null> {
  return withPrincipal(
    p,
    async (tx) => {
      const c = await tx.query(
        `select id from deedbox.assistant_conversation
          where id = $1 and staff = $2 and firm = $3`,
        [conversationId, p.id, p.firm],
      )
      if (c.rowCount === 0) return null
      const m = await tx.query(
        `select m.id, m.role, m.content, m.confidence, m.was_refusal,
                m.retrieved_slugs, m.created_at,
                (select f.rating from deedbox.assistant_feedback f
                  where f.message = m.id and f.staff = $2
                  order by f.id desc limit 1) as my_rating
           from deedbox.assistant_message m
          where m.conversation = $1
          order by m.id`,
        [conversationId, p.id],
      )
      return {
        id: conversationId,
        messages: m.rows.map((r: Record<string, unknown>) => ({
          id: r.id as number,
          role: r.role as string,
          content: r.content as string,
          confidence: (r.confidence as string | null) ?? null,
          wasRefusal: r.was_refusal === true,
          retrievedSlugs: (r.retrieved_slugs as string[]) ?? [],
          createdAt: String(r.created_at),
          myRating: (r.my_rating as string | null) ?? null,
        })),
      }
    },
    { readOnly: true },
  )
}

export interface HelpArticleRow {
  id: number
  slug: string
  title: string
  summary: string
  module: string
  origin: string
  status: string
  needsCapability: string | null
}

export async function publishedArticles(p: Principal): Promise<HelpArticleRow[]> {
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select id, slug, title, summary, module, origin, status, needs_capability
           from deedbox.assistant_article
          where status = 'published' and (origin = 'engine' or firm = $1)
          order by module, title`,
        [p.firm],
      )
      return r.rows.map(mapArticleRow)
    },
    { readOnly: true },
  )
}

export interface HelpArticle extends HelpArticleRow {
  body: string
  steps: string[]
  warnings: string | null
  routes: string[]
  related: string[]
  lastVerified: string | null
}

export async function articleBySlug(p: Principal, slug: string): Promise<HelpArticle | null> {
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select * from deedbox.assistant_article
          where slug = $2 and status = 'published' and (origin = 'engine' or firm = $1)
          order by origin desc limit 1`,
        [p.firm, slug],
      )
      if (r.rowCount === 0) return null
      const row = r.rows[0] as Record<string, unknown>
      return {
        ...mapArticleRow(row),
        body: (row.body as string) ?? '',
        steps: Array.isArray(row.steps) ? (row.steps as string[]) : [],
        warnings: (row.warnings as string | null) ?? null,
        routes: (row.routes as string[]) ?? [],
        related: (row.related as string[]) ?? [],
        lastVerified: row.last_verified ? String(row.last_verified) : null,
      }
    },
    { readOnly: true },
  )
}

function mapArticleRow(r: Record<string, unknown>): HelpArticleRow {
  return {
    id: r.id as number,
    slug: r.slug as string,
    title: r.title as string,
    summary: r.summary as string,
    module: r.module as string,
    origin: r.origin as string,
    status: r.status as string,
    needsCapability: (r.needs_capability as string | null) ?? null,
  }
}

export interface AssistantAdminData {
  articles: HelpArticleRow[]
  gaps: {
    id: number
    question: string
    route: string | null
    confidence: string | null
    status: string
    createdAt: string
  }[]
  feedback: {
    id: number
    rating: string
    note: string | null
    createdAt: string
    answerExcerpt: string
  }[]
  capabilityKeys: string[]
}

export async function assistantAdmin(p: Principal): Promise<AssistantAdminData> {
  return withPrincipal(
    p,
    async (tx) => {
      if (!(await hasCapability(tx, p.id, 'assistant.manage'))) {
        throw new OperationRefused(
          'capability_missing',
          'this screen requires assistant.manage',
        )
      }
      const articles = await tx.query(
        `select id, slug, title, summary, module, origin, status, needs_capability
           from deedbox.assistant_article
          where origin = 'engine' or firm = $1
          order by origin desc, module, title`,
        [p.firm],
      )
      const gaps = await tx.query(
        `select id, question, route, confidence, status, created_at
           from deedbox.assistant_gap
          where firm = $1
          order by case status when 'open' then 0 when 'reviewed' then 1 else 2 end,
                   created_at desc
          limit 100`,
        [p.firm],
      )
      const feedback = await tx.query(
        `select f.id, f.rating, f.note, f.created_at,
                left(m.content, 160) as answer_excerpt
           from deedbox.assistant_feedback f
           join deedbox.assistant_message m on m.id = f.message
           join deedbox.assistant_conversation c on c.id = m.conversation
          where c.firm = $1
          order by f.id desc
          limit 50`,
        [p.firm],
      )
      const caps = await tx.query(`select key from deedbox.capability order by key`)
      return {
        articles: articles.rows.map(mapArticleRow),
        gaps: gaps.rows.map((r: Record<string, unknown>) => ({
          id: r.id as number,
          question: r.question as string,
          route: (r.route as string | null) ?? null,
          confidence: (r.confidence as string | null) ?? null,
          status: r.status as string,
          createdAt: String(r.created_at),
        })),
        feedback: feedback.rows.map((r: Record<string, unknown>) => ({
          id: r.id as number,
          rating: r.rating as string,
          note: (r.note as string | null) ?? null,
          createdAt: String(r.created_at),
          answerExcerpt: (r.answer_excerpt as string) ?? '',
        })),
        capabilityKeys: caps.rows.map((r: Record<string, unknown>) => r.key as string),
      }
    },
    { readOnly: true },
  )
}

export async function firmArticleForEdit(
  p: Principal,
  id: number,
): Promise<HelpArticle | null> {
  return withPrincipal(
    p,
    async (tx) => {
      if (!(await hasCapability(tx, p.id, 'assistant.manage'))) {
        throw new OperationRefused(
          'capability_missing',
          'this screen requires assistant.manage',
        )
      }
      const r = await tx.query(
        `select * from deedbox.assistant_article
          where id = $2 and origin = 'firm' and firm = $1`,
        [p.firm, id],
      )
      if (r.rowCount === 0) return null
      const row = r.rows[0] as Record<string, unknown>
      return {
        ...mapArticleRow(row),
        body: (row.body as string) ?? '',
        steps: Array.isArray(row.steps) ? (row.steps as string[]) : [],
        warnings: (row.warnings as string | null) ?? null,
        routes: (row.routes as string[]) ?? [],
        related: (row.related as string[]) ?? [],
        lastVerified: row.last_verified ? String(row.last_verified) : null,
      }
    },
    { readOnly: true },
  )
}
