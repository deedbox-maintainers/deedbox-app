// The ask pipeline: screen → retrieve → model → validate → access caveat →
// telemetry. Single-turn by design: no history is ever sent to the model —
// the conversation id only groups the telemetry so the help page can render
// the thread.
//
// Transaction shape: the user's question is logged FIRST in its own
// committed transaction (honest telemetry even when the model call then
// fails), the model call runs OUTSIDE any transaction (external latency
// never holds a connection), and the answer + gap land together at the end.

import type { Principal } from '@/lib/db'
import { withPrincipal } from '@/lib/db'
import { requireStaff, hasCapability } from '@/lib/ops/shared'
import { OperationRefused } from '@/lib/db'
import { screenUserMessage, validateAnswer, REFUSAL_USAGE } from './guardrails'
import { searchHelpInTx, confidenceFor, type Confidence, type RetrievedChunk } from './retrieval'
import { ASSISTANT_SYSTEM, buildUserText, parseModelOutput } from './prompt'
import { assistantModelService } from './seam'

export interface AskResult {
  conversationId: number
  messageId: number
  answer: string
  sources: { slug: string; title: string }[]
  confidence: Confidence
  refused: boolean
}

/**
 * The exact, deterministic access caveat. Computed HERE in code from the
 * asking staff member's real role grants — the model never decides who can
 * access what, and a caveat is only produced when the person provably
 * lacks the capability the feature needs (never falsely denying).
 */
function accessCaveat(featureTitle: string): string {
  return `Heads up — "${featureTitle}" needs a permission your role may not have, so you may not see it. If you expected access, check with your firm administrator. Here is how it works anyway:`
}

export async function askAssistant(
  p: Principal,
  input: { question: string; conversationId?: number; route?: string | null },
): Promise<AskResult> {
  requireStaff(p)
  const question = (input.question ?? '').trim()
  if (!question) throw new OperationRefused('question_required', 'ask a question first')
  const route =
    input.route && /^\/[a-zA-Z0-9/_:.\-[\]]*$/.test(input.route) ? input.route : null
  const startedAt = Date.now()

  // 1) Pre-flight screen: the most dangerous asks never reach the model.
  const screen = screenUserMessage(question)

  // 2) Open/verify the conversation and log the question — its own
  //    committed transaction, so the telemetry is honest whatever follows.
  const { conversationId, userLogged } = await withPrincipal(p, async (tx) => {
    let conv = input.conversationId ?? null
    if (conv !== null) {
      const own = await tx.query(
        `select id from deedbox.assistant_conversation where id = $1 and staff = $2 and firm = $3`,
        [conv, p.id, p.firm],
      )
      if (own.rowCount === 0) conv = null
    }
    if (conv === null) {
      const r = await tx.query(
        `insert into deedbox.assistant_conversation (firm, staff, entry_route)
         values ($1, $2, $3) returning id`,
        [p.firm, p.id, route],
      )
      conv = r.rows[0].id as number
    }
    const m = await tx.query(
      `insert into deedbox.assistant_message (conversation, role, content, route)
       values ($1, 'user', $2, $3) returning id`,
      [conv, question.slice(0, 4000), route],
    )
    return { conversationId: conv, userLogged: m.rows[0].id as number }
  })
  void userLogged

  if (screen.hardRefuse) {
    const messageId = await logAssistantMessage(p, {
      conversationId,
      content: screen.refusalText ?? REFUSAL_USAGE,
      route,
      retrievedSlugs: [],
      confidence: 'none',
      wasRefusal: true,
      flags: screen.flags,
      model: 'none',
      latencyMs: Date.now() - startedAt,
      gapQuestion: null,
    })
    return {
      conversationId,
      messageId,
      answer: screen.refusalText ?? REFUSAL_USAGE,
      sources: [],
      confidence: 'none',
      refused: true,
    }
  }

  // 3) Retrieve from the published knowledge base.
  const chunks: RetrievedChunk[] = await withPrincipal(
    p,
    (tx) => searchHelpInTx(tx, p.firm, question, route),
    { readOnly: true },
  )
  const confidence = confidenceFor(chunks)

  // 4) The model, through the seam — outside any transaction. Unbound
  //    installations refuse typed here; the question stays logged.
  const svc = assistantModelService()
  const rawReply = await svc.answer({
    system: ASSISTANT_SYSTEM,
    user: buildUserText(question, route, chunks, confidence),
    maxTokens: 1500,
  })
  const out = parseModelOutput(rawReply, chunks, confidence)

  // 5) Validate before the answer is ever shown.
  const validated = validateAnswer(out.answer, out.refused)

  // 6) Role-aware access — decided in code from real grants. Only when we
  //    are confident what they asked about (high/medium).
  const primary = out.primarySource
    ? chunks.find((c) => c.slug === out.primarySource)
    : chunks[0]
  let caveated = validated.answer
  let caveatFlag: string[] = []
  if (
    primary?.needsCapability &&
    (confidence === 'high' || confidence === 'medium')
  ) {
    const holds = await withPrincipal(
      p,
      (tx) => hasCapability(tx, p.id, primary.needsCapability as string),
      { readOnly: true },
    )
    if (!holds) {
      caveated = `${accessCaveat(primary.title)}\n\n${validated.answer}`
      caveatFlag = ['access_caveat']
    }
  }
  const flags = [...new Set([...screen.flags, ...validated.flags, ...caveatFlag])]

  // 7) The answer and, on low/none confidence, the knowledge gap.
  const messageId = await logAssistantMessage(p, {
    conversationId,
    content: caveated,
    route,
    retrievedSlugs: chunks.map((c) => c.slug),
    confidence: out.confidence,
    wasRefusal: validated.refused,
    flags,
    model: svc.model,
    latencyMs: Date.now() - startedAt,
    gapQuestion:
      out.confidence === 'low' || out.confidence === 'none' ? question : null,
  })

  return {
    conversationId,
    messageId,
    answer: caveated,
    sources: out.usedSources,
    confidence: out.confidence,
    refused: validated.refused,
  }
}

async function logAssistantMessage(
  p: Principal,
  args: {
    conversationId: number
    content: string
    route: string | null
    retrievedSlugs: string[]
    confidence: Confidence
    wasRefusal: boolean
    flags: string[]
    model: string | null
    latencyMs: number
    gapQuestion: string | null
  },
): Promise<number> {
  return withPrincipal(p, async (tx) => {
    const m = await tx.query(
      `insert into deedbox.assistant_message
         (conversation, role, content, route, retrieved_slugs, confidence,
          was_refusal, guardrail_flags, model, latency_ms)
       values ($1, 'assistant', $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        args.conversationId,
        args.content.slice(0, 8000),
        args.route,
        args.retrievedSlugs,
        args.confidence,
        args.wasRefusal,
        args.flags,
        args.model,
        args.latencyMs,
      ],
    )
    const messageId = m.rows[0].id as number
    if (args.gapQuestion) {
      await tx.query(
        `insert into deedbox.assistant_gap
           (firm, question, route, staff, retrieved_slugs, confidence, message)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          p.firm,
          args.gapQuestion.slice(0, 2000),
          args.route,
          p.id,
          args.retrievedSlugs,
          args.confidence,
          messageId,
        ],
      )
    }
    return messageId
  })
}
