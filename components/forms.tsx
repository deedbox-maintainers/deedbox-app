// Form primitives. Plain HTML forms posting to server actions — no client
// JavaScript; refusals and outcomes travel back as query-string notices via
// the action helper (lib/screens/action.ts).

import type { ReactNode } from 'react'

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="mb-3 block text-sm">
      <span className="mb-1 block font-medium text-neutral-700">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-neutral-400">{hint}</span> : null}
    </label>
  )
}

const inputClass =
  'w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-900 focus:border-sky-500 focus:outline-none'

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ''}`} />
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputClass} ${props.className ?? ''}`} />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${props.className ?? ''}`} />
}

export function Checkbox({ name, label, defaultChecked }: { name: string; label: ReactNode; defaultChecked?: boolean }) {
  return (
    <label className="mb-2 flex items-center gap-2 text-sm text-neutral-700">
      <input type="checkbox" name={name} value="on" defaultChecked={defaultChecked} className="h-4 w-4" />
      {label}
    </label>
  )
}

export function SubmitButton({
  children,
  tone = 'primary',
}: {
  children: ReactNode
  tone?: 'primary' | 'quiet' | 'danger'
}) {
  const tones: Record<string, string> = {
    primary: 'bg-[var(--brand-primary,#171717)] text-white hover:opacity-90',
    quiet: 'border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50',
    danger: 'bg-red-700 text-white hover:bg-red-600',
  }
  return (
    <button type="submit" className={`rounded-md px-3 py-1.5 text-sm font-medium ${tones[tone]}`}>
      {children}
    </button>
  )
}

/** A one-button inline form for row actions. */
export function InlineAction({
  action,
  fields,
  label,
  tone = 'quiet',
  confirm,
}: {
  action: (formData: FormData) => Promise<void>
  fields: Record<string, string | number>
  label: ReactNode
  tone?: 'primary' | 'quiet' | 'danger'
  confirm?: boolean
}) {
  return (
    <form action={action} className="inline">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={String(v)} />
      ))}
      {confirm ? (
        <input type="hidden" name="confirmed" value="on" />
      ) : null}
      <SubmitButton tone={tone}>{label}</SubmitButton>
    </form>
  )
}

/**
 * A form field that cannot be read as what the action needs. Thrown by the
 * parsers below and turned into an on-screen refusal by the action wrapper —
 * never a server error. (Found in production: a ledger's human number typed
 * into a numeric-id box became NaN, reached the database as a bigint and
 * failed with a 500.)
 */
export class FormValueError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message)
    this.name = 'FormValueError'
  }
}

/** FormData parsing helpers for actions. */
export const parse = {
  str(fd: FormData, key: string): string {
    const v = fd.get(key)
    return typeof v === 'string' ? v.trim() : ''
  },
  strOrNull(fd: FormData, key: string): string | null {
    const v = this.str(fd, key)
    return v === '' ? null : v
  },
  /** A required number: empty or non-numeric refuses typed, never NaN. */
  num(fd: FormData, key: string): number {
    const v = this.str(fd, key)
    const n = Number(v)
    if (v === '' || !Number.isFinite(n)) {
      throw new FormValueError(
        key,
        v === '' ? `${key.replace(/_/g, ' ')} is required` : `"${v}" is not a number (${key.replace(/_/g, ' ')})`,
      )
    }
    return n
  },
  /** An optional number: empty is null; anything else must be numeric. */
  numOrNull(fd: FormData, key: string): number | null {
    const v = this.str(fd, key)
    if (v === '') return null
    const n = Number(v)
    if (!Number.isFinite(n)) {
      throw new FormValueError(key, `"${v}" is not a number (${key.replace(/_/g, ' ')})`)
    }
    return n
  },
  bool(fd: FormData, key: string): boolean {
    return fd.get(key) === 'on' || fd.get(key) === 'true'
  },
}
