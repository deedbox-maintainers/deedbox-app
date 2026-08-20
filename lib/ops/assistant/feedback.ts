// Answer feedback: any staff member can rate an assistant
// answer from their own firm's conversations. Append-only telemetry.

import type { Principal } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'

const RATINGS = ['up', 'down', 'wrong', 'needs_detail'] as const
export type FeedbackRating = (typeof RATINGS)[number]

export async function recordAssistantFeedback(
  p: Principal,
  input: { messageId: number; rating: FeedbackRating; note?: string | null },
): Promise<void> {
  requireStaff(p)
  if (!RATINGS.includes(input.rating)) {
    throw new OperationRefused('bad_rating', 'unknown feedback rating')
  }
  await withPrincipal(p, async (tx) => {
    const m = await tx.query(
      `select 1
         from deedbox.assistant_message m
         join deedbox.assistant_conversation c on c.id = m.conversation
        where m.id = $1 and m.role = 'assistant' and c.firm = $2`,
      [input.messageId, p.firm],
    )
    if (m.rowCount === 0) {
      throw new OperationRefused('message_not_found', 'no such assistant answer')
    }
    await tx.query(
      `insert into deedbox.assistant_feedback (message, staff, rating, note)
       values ($1, $2, $3, $4)`,
      [input.messageId, p.id, input.rating, input.note?.slice(0, 2000) || null],
    )
  })
}
