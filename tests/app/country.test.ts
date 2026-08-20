// The country lint: the engine ships jurisdiction-neutral, and this suite
// makes that a promise a third party can check — exactly as the brand lint
// (brand.test.ts) keeps the product's identity inside lib/brand.ts. Country
// conventions live in TWO declared places only:
//
//   lib/format.ts            the regional-format home (compatibility locale,
//                            currency fallback, merge/ISO locales, paper size)
//   lib/ops/billing/aba.ts   the Australian bank-payment-file renderer —
//                            engine-carried until a payment-file rule point
//                            exists, and gated on the active pack declaring
//                            BSB-shaped accounts (bankFileAvailable)
//
// Everything else renders country content from DATA: the firm's own
// operating_currency, and the active country pack's declarations (tax keys
// and labels, bank identifier fields, document wording). A new country must
// be expressible as a pack, never as engine edits — this lint is what keeps
// that true after publication.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['app', 'components', 'lib']
const ALLOW = new Set(['lib/format.ts', 'lib/ops/billing/aba.ts'])

// Each pattern names one country fingerprint. Word boundaries keep ordinary
// words (audit, gusto…) out of scope; comments are stripped before matching
// so explanations stay legal and code does not.
const BANNED: { name: string; re: RegExp }[] = [
  { name: 'locale literal', re: /\ben-AU\b|\ben-GB\b|\ben-CA\b|\ben-US\b/ },
  { name: 'currency literal', re: /\bAUD\b|\bNZD\b|\bGBP\b|\bUSD\b/ },
  { name: 'Australian bank vocabulary', re: /\bBSB\b|\bAPCA\b/ },
  { name: 'Australian tax vocabulary', re: /\bGST\b|\bgst_free\b/ },
  { name: 'statutory document title', re: /tax invoice/i },
  { name: 'paper size', re: /size:\s*A4/ },
  { name: 'bank file extension', re: /\.aba\b/ },
]

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p)
    else if (/\.(ts|tsx)$/.test(name)) yield p
  }
}

/** Strip comments so the check bites on code and markup, not on explanations. */
function code(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('no engine surface hard-codes a country', () => {
  it('country conventions live only in lib/format.ts and the gated Australian renderer', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const f of files(join(process.cwd(), root))) {
        const rel = f.slice(process.cwd().length + 1).replace(/\\/g, '/')
        if (ALLOW.has(rel)) continue
        const c = code(readFileSync(f, 'utf8'))
        for (const b of BANNED) {
          if (b.re.test(c)) offenders.push(`${rel} (${b.name})`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
