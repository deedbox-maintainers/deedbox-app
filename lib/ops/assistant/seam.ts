// The assistant model seam: the AI provider is a service the
// deployment binds — exactly the email-transport/sign-in/M365 posture.
// Unbound, asking refuses typed; the knowledge base stands without it.

import { OperationRefused } from '@/lib/db'
import { seamSlot } from '@/lib/seam-slot'

export interface AssistantModelService {
  /** The model name recorded on the telemetry rows. */
  readonly model: string
  /** One grounded help answer: raw model text back (the caller parses). */
  answer(input: { system: string; user: string; maxTokens: number }): Promise<string>
}

// Process-wide, not module-level: see lib/seam-slot.ts for why.
const slot = seamSlot<AssistantModelService>('assistant-model-service')

export function setAssistantModelService(svc: AssistantModelService | null): void {
  slot.set(svc)
}

export function assistantModelService(): AssistantModelService {
  const bound = slot.get()
  if (!bound) {
    throw new OperationRefused(
      'assistant_unbound',
      'the help assistant has no AI provider configured on this installation — the help articles under Help remain available',
    )
  }
  return bound
}
