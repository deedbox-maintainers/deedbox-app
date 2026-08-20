// Firm message-template administration (schema change 0017). Pack templates
// are schema-guarded read-only; firm templates validate their tokens
// against the purpose's catalogue before anything is written (an unknown
// token refuses, naming it), and every change registers template.changed
// with the full before/after body.
//
// The token catalogue is the closed set each purpose's renderer actually
// resolves (the reminder engine documents its seven; statement and top-up
// senders share the money-facing set). A token added to a renderer is added
// here in the same change — the catalogue and the renderers ship together.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'

export const TEMPLATE_PURPOSE_TOKENS: Record<string, string[]> = {
  reminder: [
    'firm_name',
    'bill_number',
    'amount_outstanding',
    'due_date',
    'matter_number',
    'payment_link',
    'client_name',
  ],
  instalment: [
    'firm_name',
    'client_name',
    'amount_due',
    'due_date',
    'arrangement_reference',
    'payment_link',
  ],
  statement: ['firm_name', 'client_name', 'statement_number', 'total_outstanding', 'payment_link'],
  top_up: ['firm_name', 'client_name', 'matter_number', 'amount_requested', 'request_number'],
  schedule_send: ['firm_name', 'recipient_name', 'report_name', 'period_label'],
  general: ['firm_name', 'client_name', 'matter_number'],
}

function validateTokens(purpose: string, subject: string | null, body: string): string[] {
  const allowed = TEMPLATE_PURPOSE_TOKENS[purpose]
  if (!allowed) {
    throw new OperationRefused(
      'unknown_purpose',
      `no template purpose named ${purpose} — the catalogue is ${Object.keys(TEMPLATE_PURPOSE_TOKENS).join(', ')}`,
    )
  }
  const used = new Set<string>()
  for (const text of [subject ?? '', body]) {
    for (const m of text.matchAll(/\{\{([a-z_]+)\}\}/g)) {
      if (!allowed.includes(m[1])) {
        throw new OperationRefused(
          'unknown_token',
          `{{${m[1]}}} is not a token of the ${purpose} purpose — its tokens are ${allowed.map((t) => `{{${t}}}`).join(', ')}`,
        )
      }
      used.add(m[1])
    }
  }
  return [...used]
}

export interface CreateTemplateInput {
  name: string
  channel: 'email' | 'text_message' | 'task'
  purpose: string
  subject?: string
  body: string
}

export async function createMessageTemplate(
  p: Principal,
  input: CreateTemplateInput,
): Promise<{ template: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'templates.manage')
    const tokens = validateTokens(input.purpose, input.subject ?? null, input.body)
    if (input.channel === 'email' && !input.subject) {
      throw new OperationRefused('subject_required', 'an email template needs a subject line')
    }
    const dup = await tx.query(
      `select 1 from deedbox.message_template where name = $1 and channel = $2 and active`,
      [input.name, input.channel],
    )
    if ((dup.rowCount ?? 0) > 0) {
      throw new OperationRefused('duplicate_name', `an active ${input.channel} template already uses that name`)
    }
    const ins = await tx.query(
      `insert into deedbox.message_template (name, channel, purpose, subject, body, tokens_used)
       values ($1,$2,$3,$4,$5,$6::jsonb) returning id`,
      [input.name, input.channel, input.purpose, input.subject ?? null, input.body, JSON.stringify(tokens)],
    )
    await emitRegister(tx, p, {
      kind: 'template.changed',
      subjectType: 'message_template',
      subject: ins.rows[0].id,
      detail: {
        created: { name: input.name, channel: input.channel, purpose: input.purpose, body: input.body },
      },
    })
    return { template: ins.rows[0].id as number }
  })
}

async function loadFirmTemplate(tx: Tx, id: number) {
  const r = await tx.query(
    `select id, name, channel, purpose, subject, body, pack_version, active
       from deedbox.message_template where id = $1`,
    [id],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'no such template')
  if (r.rows[0].pack_version !== null) {
    throw new OperationRefused('pack_owned', 'pack templates are read-only to the firm; a pack activation supersedes them')
  }
  return r.rows[0]
}

export async function editMessageTemplate(
  p: Principal,
  input: { template: number; name?: string; subject?: string | null; body?: string },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'templates.manage')
    const before = await loadFirmTemplate(tx, input.template)
    const nextSubject = input.subject === undefined ? (before.subject as string | null) : input.subject
    const nextBody = input.body ?? (before.body as string)
    const tokens = validateTokens(before.purpose as string, nextSubject, nextBody)
    if (before.channel === 'email' && !nextSubject) {
      throw new OperationRefused('subject_required', 'an email template needs a subject line')
    }
    await tx.query(
      `update deedbox.message_template
          set name = coalesce($2, name), subject = $3, body = $4, tokens_used = $5::jsonb
        where id = $1`,
      [input.template, input.name ?? null, nextSubject, nextBody, JSON.stringify(tokens)],
    )
    await emitRegister(tx, p, {
      kind: 'template.changed',
      subjectType: 'message_template',
      subject: input.template,
      detail: {
        before: { name: before.name, subject: before.subject, body: before.body },
        after: { name: input.name ?? before.name, subject: nextSubject, body: nextBody },
      },
    })
  })
}

/** Deactivation; reminder steps pointing at it demote loudly on their side. */
export async function deactivateMessageTemplate(
  p: Principal,
  input: { template: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'templates.manage')
    const before = await loadFirmTemplate(tx, input.template)
    if (!before.active) return // idempotent
    await tx.query(`update deedbox.message_template set active = false where id = $1`, [
      input.template,
    ])
    await emitRegister(tx, p, {
      kind: 'template.changed',
      subjectType: 'message_template',
      subject: input.template,
      detail: { before: { active: true }, after: { active: false } },
    })
  })
}
