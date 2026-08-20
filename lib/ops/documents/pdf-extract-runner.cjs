// The pdf text-extraction runner: a tiny child process whose
// module realm contains ONLY pdf-parse. It exists because the zip library
// the template engine requires (and the Word library before it, removed)
// poisons pdf-parse's bundled engine when they share a process — every
// parse after their load throws 'Invalid PDF structure' (proven by
// isolation probes). Bytes in on stdin, JSON out on stdout.
'use strict'

const pdfParse = require('pdf-parse/lib/pdf-parse.js')

const chunks = []
process.stdin.on('data', (c) => chunks.push(c))
process.stdin.on('end', async () => {
  try {
    const parsed = await pdfParse(Buffer.concat(chunks))
    process.stdout.write(JSON.stringify({ text: parsed.text || '' }))
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) }))
  }
})
