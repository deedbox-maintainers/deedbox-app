'use server'

// Help-article administration actions, all gated
// assistant.manage inside their operations.

import { act } from '@/lib/screens/action'
import {
  createAssistantArticle,
  updateAssistantArticle,
  setAssistantArticleStatus,
  reviewAssistantGap,
} from '@/lib/ops/assistant'

function fields(formData: FormData) {
  return {
    title: String(formData.get('title') ?? ''),
    summary: String(formData.get('summary') ?? ''),
    module: String(formData.get('module') ?? 'general'),
    body: String(formData.get('body') ?? ''),
    steps: String(formData.get('steps') ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    warnings: String(formData.get('warnings') ?? '').trim() || null,
    routes: String(formData.get('routes') ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    needsCapability: String(formData.get('needs_capability') ?? '').trim() || null,
  }
}

export async function createArticleAction(formData: FormData): Promise<void> {
  await act('/settings/assistant', async (p) => {
    const id = await createAssistantArticle(p, {
      slug: String(formData.get('slug') ?? ''),
      ...fields(formData),
    })
    return `goto:/settings/assistant/${id}?done=${encodeURIComponent('Draft created — publish it when ready.')}`
  })
}

export async function updateArticleAction(formData: FormData): Promise<void> {
  const id = Number(formData.get('id'))
  await act(`/settings/assistant/${id}`, async (p) => {
    await updateAssistantArticle(p, { id, ...fields(formData) })
    return 'Article saved.'
  })
}

export async function articleStatusAction(formData: FormData): Promise<void> {
  const id = Number(formData.get('id'))
  const back = String(formData.get('back') ?? '/settings/assistant')
  await act(back, async (p) => {
    await setAssistantArticleStatus(p, {
      id,
      status: String(formData.get('status')) as 'draft' | 'published' | 'retired',
    })
    return 'Status updated.'
  })
}

export async function gapAction(formData: FormData): Promise<void> {
  await act('/settings/assistant', async (p) => {
    await reviewAssistantGap(p, {
      id: Number(formData.get('id')),
      status: String(formData.get('status')) as 'reviewed' | 'resolved',
    })
    return 'Gap updated.'
  })
}
