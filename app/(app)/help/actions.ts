'use server'

// Help screen actions: asking rides the ask pipeline and lands
// back on the persisted conversation; feedback appends its row. Typed
// refusals (assistant_unbound above all) come back as honest notices.

import { act } from '@/lib/screens/action'
import { askAssistant, recordAssistantFeedback, type FeedbackRating } from '@/lib/ops/assistant'

export async function askAction(formData: FormData): Promise<void> {
  const from = String(formData.get('from') ?? '')
  const conversation = Number(formData.get('conversation') ?? 0)
  const back = `/help${from ? `?from=${encodeURIComponent(from)}` : ''}`
  await act(back, async (p) => {
    const r = await askAssistant(p, {
      question: String(formData.get('question') ?? ''),
      conversationId: conversation > 0 ? conversation : undefined,
      route: from || null,
    })
    return `goto:/help?c=${r.conversationId}${from ? `&from=${encodeURIComponent(from)}` : ''}`
  })
}

export async function feedbackAction(formData: FormData): Promise<void> {
  const conversation = Number(formData.get('conversation') ?? 0)
  const back = `/help?c=${conversation}`
  await act(back, async (p) => {
    await recordAssistantFeedback(p, {
      messageId: Number(formData.get('message')),
      rating: String(formData.get('rating')) as FeedbackRating,
      note: null,
    })
    return 'Thanks — noted.'
  })
}
