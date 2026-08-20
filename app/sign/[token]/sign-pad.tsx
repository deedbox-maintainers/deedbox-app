'use client'

// The signature pad: draw on a canvas, submit the image to the
// public signing route. Deliberately dependency-free.

import { useRef, useState } from 'react'

export default function SignPad({ token, signerName }: { token: string; signerName: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const drawn = useRef(false)
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const { x, y } = pos(e)
    ctx.beginPath()
    ctx.moveTo(x, y)
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const { x, y } = pos(e)
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#111'
    ctx.lineTo(x, y)
    ctx.stroke()
    drawn.current = true
  }
  function up() {
    drawing.current = false
  }
  function clear() {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (c && ctx) ctx.clearRect(0, 0, c.width, c.height)
    drawn.current = false
  }
  async function submit() {
    if (!drawn.current || !canvasRef.current) {
      setMessage('Please draw your signature first.')
      return
    }
    setState('submitting')
    const dataUrl = canvasRef.current.toDataURL('image/png')
    const r = await fetch(`/api/sign/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature_data_url: dataUrl }),
    })
    if (r.ok) {
      setState('done')
    } else {
      setState('error')
      setMessage(await r.text().catch(() => 'something went wrong'))
    }
  }

  if (state === 'done') {
    return <p><strong>Signed.</strong> Thank you, {signerName} — the firm has been given the signed copy.</p>
  }
  return (
    <div>
      <p>Draw your signature below, then press Sign.</p>
      <canvas
        ref={canvasRef}
        width={480}
        height={160}
        style={{ border: '1px solid #999', touchAction: 'none', background: '#fff' }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
      />
      <p style={{ display: 'flex', gap: '0.6rem' }}>
        <button type="button" onClick={clear} style={{ padding: '0.4rem 1rem', border: '1px solid #999', cursor: 'pointer' }}>
          Clear
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={state === 'submitting'}
          style={{ padding: '0.4rem 1rem', border: '1px solid #333', cursor: 'pointer', fontWeight: 600 }}
        >
          {state === 'submitting' ? 'Signing…' : 'Sign'}
        </button>
      </p>
      {message && <p style={{ color: '#b91c1c' }}>{message}</p>}
    </div>
  )
}
