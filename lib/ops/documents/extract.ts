// Server-side text extraction: pdf-parse for text living inside PDFs,
// mammoth for Word files. Anything else (images, scans, unknown binaries)
// honestly yields method 'none' and empty text; the browser-side image-OCR
// panel arrives as its own increment. pdf-parse is imported via its inner
// module path because the package's index self-runs a debug file under
// test loaders (known quirk).

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import PizZip from 'pizzip'

// PDF text extraction runs in a CHILD PROCESS whose realm holds only
// pdf-parse: the zip library the template engine permanently requires
// (and the Word library before it, removed) poisons pdf-parse's bundled
// engine when they share a process — every parse after their load throws
// 'Invalid PDF structure' (proven by isolation probes). Bytes go over
// stdin; JSON comes back on stdout; a hung child is killed at 30s.
const RUNNER = join(process.cwd(), 'lib', 'ops', 'documents', 'pdf-extract-runner.cjs')

function pdfParseIsolated(bytes: Buffer): Promise<{ text?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [RUNNER],
      { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err)
        try {
          resolve(JSON.parse(stdout || '{}') as { text?: string; error?: string })
        } catch (e) {
          reject(e)
        }
      },
    )
    child.stdin?.end(bytes)
  })
}

// Word raw text WITHOUT mammoth: a .docx is a zip whose text lives in
// word/document.xml — unzip with the template engine's own library and
// strip the markup. mammoth was tried and REMOVED: merely loading it
// poisons pdf-parse's realm ('Invalid PDF structure' on every later parse,
// proven by isolation probes), and raw text needs none of its cleverness.
function docxRawText(bytes: Buffer): string {
  const zip = new PizZip(bytes)
  const xml = zip.file('word/document.xml')?.asText() ?? ''
  return xml
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .trim()
}

export const EXTRACT_CAP = 200_000

// The formats extractText can actually read. The sweep consults this BEFORE
// fetching bytes, so a format that could only ever yield 'none' (video,
// audio, archives, unknown binaries) never costs a download — kept here,
// beside the extractor's own dispatch, so the two cannot drift apart.
export function extractableFormat(filename: string, contentType: string): boolean {
  const lowerName = filename.toLowerCase()
  const mime = contentType.toLowerCase()
  return (
    mime.includes('pdf') ||
    lowerName.endsWith('.pdf') ||
    mime.includes('officedocument.wordprocessing') ||
    lowerName.endsWith('.docx') ||
    mime.startsWith('text/') ||
    lowerName.endsWith('.txt') ||
    lowerName.endsWith('.csv')
  )
}

export interface ExtractedText {
  content: string
  method: 'embedded' | 'none'
}

export async function extractText(
  bytes: Buffer,
  filename: string,
  contentType: string,
): Promise<ExtractedText> {
  if (!extractableFormat(filename, contentType)) return { content: '', method: 'none' }
  const lowerName = filename.toLowerCase()
  const mime = contentType.toLowerCase()
  try {
    if (mime.includes('pdf') || lowerName.endsWith('.pdf')) {
      const parsed = await pdfParseIsolated(bytes)
      const content = (parsed.text ?? '').trim().slice(0, EXTRACT_CAP)
      return { content, method: content ? 'embedded' : 'none' }
    }
    if (mime.includes('officedocument.wordprocessing') || lowerName.endsWith('.docx')) {
      const content = docxRawText(bytes).slice(0, EXTRACT_CAP)
      return { content, method: content ? 'embedded' : 'none' }
    }
    if (mime.startsWith('text/') || lowerName.endsWith('.txt') || lowerName.endsWith('.csv')) {
      const content = bytes.toString('utf8').trim().slice(0, EXTRACT_CAP)
      return { content, method: content ? 'embedded' : 'none' }
    }
  } catch {
    // an unreadable file is honestly text-less, never a crash
  }
  return { content: '', method: 'none' }
}
