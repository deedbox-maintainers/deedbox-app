// The hosted assistant-model binding: the Anthropic Messages API behind
// the AssistantModelService seam. Configuration is deployment environment
// (like the mail key), never firm settings; the browser never talks to
// the provider — only this server-side binding does.
//
// Current-API notes (verified at build time): no temperature parameter —
// current models reject sampling parameters outright; a refusal or empty
// reply comes back as empty text, which the parser upstream turns into an
// honest "no answer" message.

import type { AssistantModelService } from '@/lib/ops/assistant/seam'

export interface AssistantModelConfig {
  apiKey: string
  /** Messages API model id; the deployment may pin one. */
  model?: string
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-opus-5'

export function hostedAssistantModel(cfg: AssistantModelConfig): AssistantModelService {
  const model = cfg.model || DEFAULT_MODEL
  return {
    model,
    async answer({ system, user, maxTokens }) {
      const r = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      })
      if (!r.ok) {
        throw new Error(
          `assistant_model_error: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`,
        )
      }
      const data = (await r.json()) as {
        content?: { type: string; text?: string }[]
      }
      const block = (data.content ?? []).find((b) => b.type === 'text')
      return block?.text ?? ''
    },
  }
}
