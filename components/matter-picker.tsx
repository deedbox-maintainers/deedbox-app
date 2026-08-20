'use client'

// The type-ahead matter box: staff pick the right file by the client's name
// or the matter number, suggested as they type — the affordance staff expect
// on every matter field. Suggestions come from the same governed matter search
// the list screen uses (row security and restricted-matter disclosure ride
// along unchanged); this component only presents them.
//
// Two modes:
//   * mode "id" (default): a hidden input carries the CHOSEN matter's
//     internal id under `name`; the visible box is display-only text. No
//     choice = no value, and the receiving action refuses on screen in its
//     own words — never a silent guess.
//   * mode "text": picking fills the visible input (named `name`) with the
//     matter number and submits the surrounding form — for find-style GET
//     forms that already accept a typed number.

import { useEffect, useRef, useState } from 'react'
import { suggestMattersAction, type MatterSuggestionRow } from '@/app/(app)/matter-picker-actions'

export default function MatterPicker({
  name,
  label,
  hint,
  mode = 'id',
  placeholder,
  initialText = '',
}: {
  name: string
  label?: string
  hint?: string
  mode?: 'id' | 'text'
  placeholder?: string
  initialText?: string
}) {
  const [text, setText] = useState(initialText)
  const [hits, setHits] = useState<MatterSuggestionRow[]>([])
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<MatterSuggestionRow | null>(null)
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
    setChosen(null)
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
        const rows = await suggestMattersAction(q)
        if (mySeq === seq.current) {
          setHits(rows)
          setOpen(true)
        }
      } finally {
        if (mySeq === seq.current) setSearching(false)
      }
    }, 250)
  }

  function pick(m: MatterSuggestionRow) {
    setChosen(m)
    setHits([])
    setOpen(false)
    if (mode === 'text') {
      setText(m.matterNumber)
      // let React commit the value, then submit the surrounding find form
      setTimeout(() => boxRef.current?.closest('form')?.requestSubmit(), 0)
    } else {
      setText(`${m.matterNumber} — ${m.clientName}`)
    }
  }

  return (
    <div ref={boxRef} className="relative mb-3">
      {label ? (
        <label className="mb-1 block text-sm font-medium text-neutral-700">{label}</label>
      ) : null}
      {mode === 'id' ? <input type="hidden" name={name} value={chosen ? String(chosen.id) : ''} /> : null}
      <input
        type="text"
        name={mode === 'text' ? name : undefined}
        value={text}
        onChange={(e) => onType(e.target.value)}
        onFocus={() => hits.length > 0 && setOpen(true)}
        placeholder={placeholder ?? 'Type a client name or matter number'}
        autoComplete="off"
        className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus:border-sky-500 focus:outline-none"
      />
      {hint ? <p className="mt-1 text-xs text-neutral-400">{hint}</p> : null}
      {open && (hits.length > 0 || searching) ? (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
          {searching && hits.length === 0 ? (
            <li className="px-3 py-1.5 text-sm text-neutral-400">searching…</li>
          ) : null}
          {hits.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => pick(m)}
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-sky-50"
              >
                <span className="font-medium">{m.matterNumber}</span>
                {' — '}
                {m.clientName}
                <span className="block truncate text-xs text-neutral-500">
                  {m.title}
                  {m.status !== 'open' ? ` (${m.status.replace(/_/g, ' ')})` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
