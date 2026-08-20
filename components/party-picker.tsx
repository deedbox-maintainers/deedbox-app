'use client'

// The type-ahead party box: staff pick a person or organisation by name,
// phone or email, suggested as they type — the same treatment the matter
// box has, closing the raw internal-number fields (a payer or client field
// asking for the database's own party id invites a number typed in good
// faith that the register then refuses). Suggestions come from the governed
// party search (merged and soft-deleted parties absent); this component
// only presents them.
//
// A hidden input carries the CHOSEN party's id under `name`; the visible
// box is display-only text. No choice = no value, and the receiving action
// refuses on screen in its own words — never a silent guess. An `initial`
// choice (e.g. arriving from a party's own page) pre-fills both.

import { useEffect, useRef, useState } from 'react'
import { suggestPartiesAction, type PartySuggestionRow } from '@/app/(app)/party-picker-actions'

export default function PartyPicker({
  name,
  label,
  hint,
  placeholder,
  initial,
}: {
  name: string
  label?: string
  hint?: string
  placeholder?: string
  initial?: { id: number; text: string }
}) {
  const [text, setText] = useState(initial?.text ?? '')
  const [hits, setHits] = useState<PartySuggestionRow[]>([])
  const [open, setOpen] = useState(false)
  const [chosenId, setChosenId] = useState<number | null>(initial?.id ?? null)
  const [searching, setSearching] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  function onType(v: string) {
    setText(v)
    setChosenId(null)
    if (timer.current) clearTimeout(timer.current)
    const q = v.trim()
    if (q.length < 2) {
      setHits([])
      setOpen(false)
      return
    }
    timer.current = setTimeout(async () => {
      const mySeq = ++seq.current
      setSearching(true)
      try {
        const rows = await suggestPartiesAction(q)
        if (mySeq === seq.current) {
          setHits(rows)
          setOpen(true)
        }
      } finally {
        if (mySeq === seq.current) setSearching(false)
      }
    }, 250)
  }

  function pick(r: PartySuggestionRow) {
    setChosenId(r.id)
    setText(r.displayName)
    setHits([])
    setOpen(false)
  }

  return (
    <div ref={boxRef} className="relative mb-3">
      {label ? (
        <label className="mb-1 block text-sm font-medium text-neutral-700">{label}</label>
      ) : null}
      <input type="hidden" name={name} value={chosenId !== null ? String(chosenId) : ''} />
      <input
        type="text"
        value={text}
        onChange={(e) => onType(e.target.value)}
        onFocus={() => hits.length > 0 && setOpen(true)}
        placeholder={placeholder ?? 'Type a name, phone or email'}
        autoComplete="off"
        className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus:border-sky-500 focus:outline-none"
      />
      {hint ? <p className="mt-1 text-xs text-neutral-400">{hint}</p> : null}
      {open && (hits.length > 0 || searching) ? (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
          {searching && hits.length === 0 ? (
            <li className="px-3 py-1.5 text-sm text-neutral-400">searching…</li>
          ) : null}
          {hits.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => pick(r)}
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-sky-50"
              >
                <span className="font-medium">{r.displayName}</span>
                {r.kind !== 'person' ? ` (${r.kind.replace(/_/g, ' ')})` : ''}
                <span className="block truncate text-xs text-neutral-500">
                  {[r.primaryPhone, r.primaryEmail].filter(Boolean).join(' · ') || '—'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
