'use server'

// The type-ahead matter search behind the picker fields. Read-only: it is
// the matter list's own governed search (matter number, old file number,
// title, client name; row security and restricted-view disclosure included)
// trimmed to a suggestion shape.

import { requirePrincipal } from '@/lib/auth'
import { matterList } from '@/lib/reads/matters'

export interface MatterSuggestionRow {
  id: number
  matterNumber: string
  clientName: string
  title: string
  status: string
}

export async function suggestMattersAction(query: string): Promise<MatterSuggestionRow[]> {
  const p = await requirePrincipal()
  const q = (query ?? '').trim()
  if (q.length < 2) return []
  const rows = await matterList(p, { q, limit: 8 })
  return rows.map((m) => ({
    id: m.id,
    matterNumber: m.matterNumber,
    clientName: m.clientName,
    title: m.title,
    status: m.status,
  }))
}
