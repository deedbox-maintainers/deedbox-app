'use server'

// The type-ahead party search behind the picker fields. Read-only: it is
// the party list's own governed search (names of every kind folded and
// phonetic, phone, email; merged and soft-deleted parties absent) trimmed
// to a suggestion shape.

import { requirePrincipal } from '@/lib/auth'
import { partyList } from '@/lib/reads/matters'

export interface PartySuggestionRow {
  id: number
  displayName: string
  kind: string
  primaryPhone: string | null
  primaryEmail: string | null
}

export async function suggestPartiesAction(query: string): Promise<PartySuggestionRow[]> {
  const p = await requirePrincipal()
  const q = (query ?? '').trim()
  if (q.length < 2) return []
  const rows = await partyList(p, { q, limit: 8 })
  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    kind: r.kind,
    primaryPhone: r.primaryPhone,
    primaryEmail: r.primaryEmail,
  }))
}
