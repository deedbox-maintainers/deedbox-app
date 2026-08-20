'use client'

// The browser image-OCR panel: when a version's stored file yielded no
// embedded text (a scan, a photographed letter), the READER'S OWN
// BROWSER does the recognition — tesseract.js and pdf.js loaded lazily
// from the CDN only when the button is pressed, pages rendered to canvas
// and recognised one by one, and the result posted back to land as the
// version's text (method 'ocr'), which feeds the same search the
// embedded path feeds. Nothing leaves the browser except the recognised
// text going home to the app.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { recordOcrTextAction } from '../actions'

const PDF_JS_VERSION = '4.7.76'
const PDF_JS_BASE = `https://esm.sh/pdfjs-dist@${PDF_JS_VERSION}`
const PDF_JS_WORKER_SRC = `https://esm.sh/pdfjs-dist@${PDF_JS_VERSION}/build/pdf.worker.min.mjs`
const TESSERACT_BASE = 'https://esm.sh/tesseract.js@5'
const MAX_PAGES = 40

type Stage =
  | { name: 'idle' }
  | { name: 'loading-libs' }
  | { name: 'downloading' }
  | { name: 'recognising'; page: number; total: number }
  | { name: 'saving' }
  | { name: 'done'; chars: number }
  | { name: 'error'; message: string }

export default function OcrPanel({
  documentId,
  filename,
}: {
  documentId: number
  filename: string
}) {
  const [stage, setStage] = useState<Stage>({ name: 'idle' })
  const router = useRouter()

  const isPdf = /\.pdf$/i.test(filename)

  async function run() {
    try {
      setStage({ name: 'loading-libs' })
      const tesseractMod = (await import(
        /* webpackIgnore: true */ TESSERACT_BASE
      )) as unknown as TesseractModule

      setStage({ name: 'downloading' })
      const resp = await fetch(`/api/documents/${documentId}/download`)
      if (!resp.ok) {
        setStage({ name: 'error', message: `could not fetch the file (HTTP ${resp.status})` })
        return
      }
      const buf = await resp.arrayBuffer()

      const worker = await tesseractMod.default.createWorker('eng', 1, { logger: () => {} })
      let collected = ''

      if (isPdf) {
        const pdfjs = (await import(/* webpackIgnore: true */ PDF_JS_BASE)) as unknown as PdfJsModule
        pdfjs.GlobalWorkerOptions.workerSrc = PDF_JS_WORKER_SRC
        const pdf = await pdfjs.getDocument({ data: buf }).promise
        const total = Math.min(pdf.numPages, MAX_PAGES)
        for (let i = 1; i <= total; i++) {
          setStage({ name: 'recognising', page: i, total })
          const page = await pdf.getPage(i)
          const viewport = page.getViewport({ scale: 2 })
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            await worker.terminate()
            setStage({ name: 'error', message: 'canvas unavailable in this browser' })
            return
          }
          await page.render({ canvasContext: ctx, viewport, canvas }).promise
          const { data } = await worker.recognize(canvas)
          const pageText = (data.text || '').trim()
          if (pageText) collected += `\n\n--- Page ${i} ---\n${pageText}`
          canvas.width = 0
          canvas.height = 0
        }
      } else {
        setStage({ name: 'recognising', page: 1, total: 1 })
        const blob = new Blob([buf])
        const url = URL.createObjectURL(blob)
        try {
          const { data } = await worker.recognize(url)
          collected = (data.text || '').trim()
        } finally {
          URL.revokeObjectURL(url)
        }
      }

      await worker.terminate()

      const text = collected.trim()
      if (!text) {
        setStage({ name: 'error', message: 'no text could be recognised in this file' })
        return
      }

      setStage({ name: 'saving' })
      const saved = await recordOcrTextAction(documentId, text)
      if (!saved.ok) {
        setStage({ name: 'error', message: saved.error })
        return
      }
      setStage({ name: 'done', chars: saved.chars })
      router.refresh()
    } catch (e) {
      setStage({ name: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const busy =
    stage.name === 'loading-libs' ||
    stage.name === 'downloading' ||
    stage.name === 'recognising' ||
    stage.name === 'saving'

  return (
    <div>
      <p className="text-sm text-slate-600">
        No text was found inside this file — it is probably a scan or a photo, so it will not
        appear in text search yet. Text recognition runs entirely in your browser; the file
        never leaves the app.
      </p>
      <button
        onClick={run}
        disabled={busy}
        className="mt-2 text-sm text-slate-700 border border-slate-300 px-4 py-2 rounded hover:bg-slate-50 disabled:opacity-50"
      >
        {stage.name === 'loading-libs'
          ? 'Loading the recogniser…'
          : stage.name === 'downloading'
            ? 'Fetching the file…'
            : stage.name === 'recognising'
              ? `Recognising page ${stage.page} of ${stage.total}…`
              : stage.name === 'saving'
                ? 'Saving the text…'
                : 'Run text recognition'}
      </button>
      {stage.name === 'done' && (
        <p className="mt-2 text-sm text-green-700">
          Done — {stage.chars.toLocaleString()} characters recognised and saved. The document is
          now text-searchable.
        </p>
      )}
      {stage.name === 'error' && <p className="mt-2 text-sm text-red-700">{stage.message}</p>}
    </div>
  )
}

// Minimal types for the CDN dynamic imports
interface PdfJsModule {
  GlobalWorkerOptions: { workerSrc: string }
  getDocument: (src: { data: ArrayBuffer }) => { promise: Promise<PdfDocument> }
}
interface PdfDocument {
  numPages: number
  getPage: (n: number) => Promise<PdfPage>
}
interface PdfPage {
  getViewport: (opts: { scale: number }) => { width: number; height: number }
  render: (opts: {
    canvasContext: CanvasRenderingContext2D
    viewport: { width: number; height: number }
    canvas?: HTMLCanvasElement
  }) => { promise: Promise<void> }
}
interface TesseractWorker {
  recognize: (input: HTMLCanvasElement | string) => Promise<{ data: { text?: string } }>
  terminate: () => Promise<void>
}
interface TesseractModule {
  default: {
    createWorker: (
      lang: string,
      oem: number,
      options: { logger?: (msg: unknown) => void },
    ) => Promise<TesseractWorker>
  }
}
