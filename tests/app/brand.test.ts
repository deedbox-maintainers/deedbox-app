// White-labelling: every installation is DeedBox by default; a firm may give
// it its own name, logo, browser-tab icon and colours through the branding
// slot, and every product surface reads lib/brand.ts instead of carrying the
// product's identity. This suite proves the default, the write (files
// bytes-first through the byte-store seam, the slot through the registered
// operation), the refusals that keep a logo a picture, the reset — and a
// lint that no product surface hard-codes the name or the default artwork.
//
// Cross-suite contract: runs after bindings, before bulk-import. Binds the
// byte store/fetch seams and UNBINDS them in afterAll; deletes its branding
// row in afterAll so the private-layer suite (which writes the same
// 'default' entry later) starts from a clean slot. Flips no firm settings.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { readBrand, brandFromValue, DEFAULT_BRAND, PRODUCT_NAME, BRAND_ENTRY_KEY } from '@/lib/brand'
import { serveBrandFile } from '@/lib/brandRoute'
import { setBranding, resetBranding, keepDefaultBranding } from '@/lib/ops/config'
import { setDocumentByteStore, setDocumentByteFetch } from '@/lib/ops/documents/store'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let L: Principal
const stored: { ref: string; bytes: Buffer; filename: string }[] = []

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0A3A78"/></svg>')

async function clearSlot() {
  await admin.query(`delete from deedbox.config_slot where slot = 'branding' and entry_key = $1`, [BRAND_ENTRY_KEY])
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'brd')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  const role = await admin.query(`select id from deedbox.role where system_key = 'lawyer'`)
  const s = await admin.query(
    `insert into deedbox.staff_member (person_name, login, role, office, email)
     values ('{"given":"Law","family":"Brd"}', 'law.brd', $1, $2, 'law.brd@example.test') returning id`,
    [role.rows[0].id, fx.office],
  )
  L = { kind: 'staff', id: s.rows[0].id as number, firm: fx.firm }
  await clearSlot()
  // a recording byte store: bytes-first, returns a reference like the hosted one
  setDocumentByteStore(async (input) => {
    const ref = `${input.matter ?? 'templates'}/brd-${stored.length + 1}-${input.filename}`
    stored.push({ ref, bytes: input.bytes, filename: input.filename })
    return { storageRef: ref, contentType: 'application/octet-stream' }
  })
  setDocumentByteFetch(async (ref) => {
    const hit = stored.find((s) => s.ref === ref)
    if (!hit) throw new Error('no such object')
    return { bytes: hit.bytes, contentType: 'application/octet-stream' }
  })
})

afterAll(async () => {
  setDocumentByteStore(null)
  setDocumentByteFetch(null)
  await clearSlot()
  await closePool()
  await admin.end()
})

describe('the default look', () => {
  it('reads as DeedBox when nothing is set', async () => {
    const b = await readBrand()
    expect(b).toEqual(DEFAULT_BRAND)
    expect(b.name).toBe(PRODUCT_NAME)
    expect(b.isDefault).toBe(true)
  })

  it('an empty or partial slot still resolves every field', () => {
    expect(brandFromValue({})).toEqual(DEFAULT_BRAND)
    const b = brandFromValue({ display_name: '  Northgate Law  ' })
    expect(b.name).toBe('Northgate Law')
    expect(b.logoHref).toBe(DEFAULT_BRAND.logoHref)
    expect(b.isDefault).toBe(false)
  })
})

describe('a firm white-labels the installation', () => {
  it('stores the logo bytes-first, writes the slot through the registered operation, and every surface reads it', async () => {
    const out = await setBranding(P, {
      displayName: 'Northgate Law',
      colourPrimary: '#0a3a78',
      logo: { filename: 'northgate-lockup.svg', bytes: SVG },
    })
    expect(out.value.display_name).toBe('Northgate Law')
    expect(out.value.colour_primary).toBe('#0A3A78')
    expect(out.value.logo).toMatch(/^templates\/brd-1-brand-logo\.svg$/)
    expect(stored[0].bytes.equals(SVG)).toBe(true)

    const b = await readBrand()
    expect(b.name).toBe('Northgate Law')
    expect(b.isDefault).toBe(false)
    expect(b.colourPrimary).toBe('#0A3A78')
    expect(b.logoHref).toMatch(/^\/brand\/logo\?v=[a-z0-9]+$/)
    expect(b.iconHref).toBe(DEFAULT_BRAND.iconHref) // no icon uploaded → the product's

    const reg = await admin.query(
      `select detail from deedbox.register_entry
        where event_kind = 'setting.changed' and subject_type = 'config_slot'
          and detail->'after'->'value'->>'display_name' = 'Northgate Law'
        order by id desc limit 1`,
    )
    expect(reg.rowCount).toBe(1)
  })

  it('serves the uploaded logo as a picture, and the default when nothing is uploaded', async () => {
    const r = await serveBrandFile('logo', 'https://firm.example/brand/logo')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/svg+xml')
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(Buffer.from(await r.arrayBuffer()).equals(SVG)).toBe(true)

    const icon = await serveBrandFile('icon', 'https://firm.example/brand/icon') // not uploaded → the product's own file
    expect(icon.status).toBe(302)
    expect(icon.headers.get('location')).toBe(`https://firm.example${DEFAULT_BRAND.iconHref}`)
  })

  it('a partial update keeps what it does not mention; a blank name goes back to the default', async () => {
    await setBranding(P, { colourSecondary: '#1b2430' })
    let b = await readBrand()
    expect(b.name).toBe('Northgate Law')
    expect(b.colourSecondary).toBe('#1B2430')
    expect(b.logoRef).toMatch(/brand-logo\.svg$/)

    await setBranding(P, { displayName: '' })
    b = await readBrand()
    expect(b.name).toBe(PRODUCT_NAME)
    expect(b.logoRef).toMatch(/brand-logo\.svg$/) // the logo stays
    expect(b.isDefault).toBe(false)
  })

  it('refuses what would make a logo dangerous or wrong', async () => {
    await expect(setBranding(P, { colourPrimary: 'blue' })).rejects.toMatchObject({ code: 'brand_colour' })
    await expect(
      setBranding(P, { logo: { filename: 'x.exe', bytes: Buffer.from('MZ') } }),
    ).rejects.toMatchObject({ code: 'brand_file_type' })
    await expect(
      setBranding(P, { logo: { filename: 'evil.svg', bytes: Buffer.from('<svg><script>alert(1)</script></svg>') } }),
    ).rejects.toMatchObject({ code: 'brand_file_unsafe' })
    await expect(
      setBranding(P, { logo: { filename: 'evil2.svg', bytes: Buffer.from('<svg onload="x()"></svg>') } }),
    ).rejects.toMatchObject({ code: 'brand_file_unsafe' })
    await expect(
      setBranding(P, { icon: { filename: 'big.png', bytes: Buffer.alloc(512 * 1024 + 1) } }),
    ).rejects.toMatchObject({ code: 'brand_file_size' })
    await expect(setBranding(P, { displayName: 'x'.repeat(61) })).rejects.toMatchObject({ code: 'brand_name_length' })
    await expect(
      setBranding(P, { icon: { filename: 'x.jpg', bytes: Buffer.from('a') } }),
    ).rejects.toMatchObject({ code: 'brand_file_type' }) // an icon is square: svg/png/ico only
  })

  it('needs an administrator — a lawyer is refused before anything is stored', async () => {
    const before = stored.length
    await expect(
      setBranding(L, { displayName: 'Nope', logo: { filename: 'l.svg', bytes: SVG } }),
    ).rejects.toMatchObject({ code: 'capability_missing' })
    expect(stored.length).toBe(before)
  })

  it('reset takes the installation back to DeedBox — and remembers that the default was chosen', async () => {
    await resetBranding(P)
    const b = await readBrand()
    expect({ ...b, decided: false }).toEqual(DEFAULT_BRAND)
    expect(b.isDefault).toBe(true)
    expect(b.decided).toBe(true) // choosing the default is a decision: no more asking
  })

  it('"leave it as it is" keeps the default look and records the choice; branding later still works', async () => {
    await admin.query(`delete from deedbox.config_slot where slot = 'branding' and entry_key = $1`, [BRAND_ENTRY_KEY])
    let b = await readBrand()
    expect(b.decided).toBe(false) // a fresh installation has not decided
    await keepDefaultBranding(P)
    b = await readBrand()
    expect(b.isDefault).toBe(true)
    expect(b.decided).toBe(true)
    expect(b.name).toBe(PRODUCT_NAME)
    await expect(keepDefaultBranding(L)).rejects.toMatchObject({ code: 'capability_missing' })
    // the firm can still change its mind
    await setBranding(P, { displayName: 'Later & Co' })
    b = await readBrand()
    expect(b.name).toBe('Later & Co')
    expect(b.decided).toBe(true)
    await resetBranding(P)
  })
})

describe('no product surface hard-codes the identity', () => {
  const ROOTS = ['app', 'components', 'lib']
  const ALLOW = new Set(['lib/brand.ts', 'lib/brandRoute.ts'])

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

  it('the product name and the default artwork paths live only in lib/brand.ts', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const f of files(join(process.cwd(), root))) {
        const rel = f.slice(process.cwd().length + 1).replace(/\\/g, '/')
        if (ALLOW.has(rel)) continue
        const c = code(readFileSync(f, 'utf8'))
        if (/DeedBox/.test(c) || /deedbox-lockup\.svg|deedbox-icon\.svg/.test(c)) offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })
})
