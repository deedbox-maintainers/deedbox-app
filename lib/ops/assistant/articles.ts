// Firm help-article administration, gated assistant.manage.
// Engine articles are release content: read-only here, replaced by
// upgrades. Retrieval chunks are DERIVED — rebuilt from the article on
// every save (delete + reinsert), exactly the composition the engine
// seed uses, so firm and engine articles retrieve identically.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireCapability } from '@/lib/ops/shared'

export interface ArticleFields {
  title: string
  summary: string
  module: string
  body?: string
  steps?: string[]
  warnings?: string | null
  routes?: string[]
  needsCapability?: string | null
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,79}$/

function cleanSteps(steps: string[] | undefined): string[] {
  return (steps ?? []).map((s) => s.trim()).filter((s) => s.length > 0)
}

function cleanRoutes(routes: string[] | undefined): string[] {
  return (routes ?? [])
    .map((r) => r.trim())
    .filter((r) => /^\/[a-zA-Z0-9/_:.\-[\]]*$/.test(r))
}

function chunkContent(a: {
  summary: string
  steps: string[]
  warnings: string | null
}): string {
  let out = a.summary
  if (a.steps.length > 0) {
    out += '\nSteps:'
    a.steps.forEach((s, i) => {
      out += `\n${i + 1}. ${s}`
    })
  }
  if (a.warnings) out += `\nNote: ${a.warnings}`
  return out
}

async function rebuildChunkInTx(
  tx: Tx,
  articleId: number,
  a: { title: string; summary: string; steps: string[]; warnings: string | null; routes: string[] },
): Promise<void> {
  await tx.query(`delete from deedbox.assistant_chunk where article = $1`, [articleId])
  await tx.query(
    `insert into deedbox.assistant_chunk (article, chunk_index, heading, content, routes)
     values ($1, 0, $2, $3, $4)`,
    [articleId, a.title, chunkContent(a), a.routes],
  )
}

async function checkCapabilityKey(tx: Tx, key: string | null | undefined): Promise<string | null> {
  if (!key) return null
  const r = await tx.query(`select 1 from deedbox.capability where key = $1`, [key])
  if (r.rowCount === 0) {
    throw new OperationRefused('unknown_capability', `no capability named ${key}`)
  }
  return key
}

export async function createAssistantArticle(
  p: Principal,
  input: { slug: string } & ArticleFields,
): Promise<number> {
  const slug = input.slug.trim().toLowerCase()
  if (!SLUG_RE.test(slug)) {
    throw new OperationRefused(
      'bad_slug',
      'the article name must be lowercase letters, digits and hyphens (2 to 80 characters)',
    )
  }
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'assistant.manage')
    const shadow = await tx.query(
      `select 1 from deedbox.assistant_article where slug = $1 and firm is null`,
      [slug],
    )
    if ((shadow.rowCount ?? 0) > 0) {
      throw new OperationRefused(
        'slug_shadows_engine',
        'a built-in help article already uses that name — pick another',
      )
    }
    const steps = cleanSteps(input.steps)
    const routes = cleanRoutes(input.routes)
    const needs = await checkCapabilityKey(tx, input.needsCapability)
    const r = await tx.query(
      `insert into deedbox.assistant_article
         (origin, firm, slug, title, summary, module, body, steps, warnings,
          routes, needs_capability, status, created_by)
       values ('firm', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11)
       returning id`,
      [
        p.firm,
        slug,
        input.title.trim(),
        input.summary.trim(),
        input.module.trim(),
        input.body?.trim() ?? '',
        JSON.stringify(steps),
        input.warnings?.trim() || null,
        routes,
        needs,
        p.id,
      ],
    )
    const id = r.rows[0].id as number
    await rebuildChunkInTx(tx, id, {
      title: input.title.trim(),
      summary: input.summary.trim(),
      steps,
      warnings: input.warnings?.trim() || null,
      routes,
    })
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'assistant_article',
      subject: id,
      detail: { slug, title: input.title.trim(), status: 'draft' },
    })
    return id
  })
}

/** Load a FIRM article this principal may administer, or refuse typed. */
async function ownFirmArticleInTx(
  tx: Tx,
  p: Principal,
  id: number,
): Promise<Record<string, unknown>> {
  const r = await tx.query(
    `select * from deedbox.assistant_article where id = $1 for update`,
    [id],
  )
  if (r.rowCount === 0) {
    throw new OperationRefused('article_not_found', 'no such help article')
  }
  const row = r.rows[0] as Record<string, unknown>
  if (row.origin === 'engine') {
    throw new OperationRefused(
      'engine_article_read_only',
      'built-in help articles are replaced by upgrades, never edited here',
    )
  }
  if (row.firm !== p.firm) {
    throw new OperationRefused('article_not_found', 'no such help article')
  }
  return row
}

export async function updateAssistantArticle(
  p: Principal,
  input: { id: number } & ArticleFields,
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'assistant.manage')
    const before = await ownFirmArticleInTx(tx, p, input.id)
    const steps = cleanSteps(input.steps)
    const routes = cleanRoutes(input.routes)
    const needs = await checkCapabilityKey(tx, input.needsCapability)
    await tx.query(
      `update deedbox.assistant_article
          set title = $2, summary = $3, module = $4, body = $5, steps = $6,
              warnings = $7, routes = $8, needs_capability = $9
        where id = $1`,
      [
        input.id,
        input.title.trim(),
        input.summary.trim(),
        input.module.trim(),
        input.body?.trim() ?? '',
        JSON.stringify(steps),
        input.warnings?.trim() || null,
        routes,
        needs,
      ],
    )
    await rebuildChunkInTx(tx, input.id, {
      title: input.title.trim(),
      summary: input.summary.trim(),
      steps,
      warnings: input.warnings?.trim() || null,
      routes,
    })
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'assistant_article',
      subject: input.id,
      detail: {
        before: { title: before.title },
        after: { title: input.title.trim() },
      },
    })
  })
}

export async function setAssistantArticleStatus(
  p: Principal,
  input: { id: number; status: 'draft' | 'published' | 'retired' },
): Promise<void> {
  if (!['draft', 'published', 'retired'].includes(input.status)) {
    throw new OperationRefused('bad_status', 'unknown article status')
  }
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'assistant.manage')
    const before = await ownFirmArticleInTx(tx, p, input.id)
    if (before.status === input.status) return
    await tx.query(`update deedbox.assistant_article set status = $2 where id = $1`, [
      input.id,
      input.status,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'assistant_article',
      subject: input.id,
      detail: {
        before: { status: before.status },
        after: { status: input.status },
      },
    })
  })
}
