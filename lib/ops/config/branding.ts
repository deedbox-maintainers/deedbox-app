// White-labelling: an administrator gives the installation the firm's own
// name, logo, browser-tab icon and colours — or takes them away again. Every
// product surface reads lib/brand.ts, so this is the only place a firm's
// identity is written, and it is written as DATA in the firm's own
// installation (the `branding` configuration slot + the firm's own object
// storage), never into the engine.
//
// The write itself goes through set_config_slot, so it carries that
// operation's capability check (private_layer.manage or security.administer)
// and its register entry (before/after) like any other configuration change.

import type { Principal } from '@/lib/db'
import { getPool, withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff, hasCapability } from '@/lib/ops/shared'
import { requireByteStore } from '@/lib/ops/documents/store'
import { setConfigSlot } from './privateLayer'
import { BRAND_ENTRY_KEY, PRODUCT_NAME, KEEP_DEFAULT_CHOICE, type BrandingValue } from '@/lib/brand'

export interface BrandFile {
  filename: string
  bytes: Buffer
}

export interface SetBrandingInput {
  displayName?: string | null
  colourPrimary?: string | null
  colourSecondary?: string | null
  logo?: BrandFile | null
  icon?: BrandFile | null
}

const NAME_MAX = 60
const FILE_MAX_BYTES = 512 * 1024
const IMAGE_EXTENSIONS = new Set(['svg', 'png', 'jpg', 'jpeg', 'webp'])
const ICON_EXTENSIONS = new Set(['svg', 'png', 'ico'])
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/

function extensionOf(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? ''
}

/** An uploaded SVG is drawn on every page: it must be a picture, never a program. */
function refuseUnsafeSvg(bytes: Buffer, what: string): void {
  const text = bytes.toString('utf8')
  const bad =
    /<script/i.test(text) ||
    /javascript:/i.test(text) ||
    /\son[a-z]+\s*=/i.test(text) ||
    /<foreignObject/i.test(text) ||
    /<iframe|<embed|<object/i.test(text) ||
    /href\s*=\s*["']?\s*(https?:|data:text\/html)/i.test(text)
  if (bad) {
    throw new OperationRefused(
      'brand_file_unsafe',
      `the ${what} SVG contains scripting or external references — a logo must be a plain picture`,
    )
  }
}

function checkFile(f: BrandFile, what: 'logo' | 'icon'): void {
  const ext = extensionOf(f.filename)
  const allowed = what === 'icon' ? ICON_EXTENSIONS : IMAGE_EXTENSIONS
  if (!allowed.has(ext)) {
    throw new OperationRefused(
      'brand_file_type',
      `the ${what} must be one of: ${[...allowed].join(', ')} — got "${ext || 'no extension'}"`,
    )
  }
  if (f.bytes.length === 0) throw new OperationRefused('brand_file_empty', `the ${what} file is empty`)
  if (f.bytes.length > FILE_MAX_BYTES) {
    throw new OperationRefused('brand_file_size', `the ${what} must be 512 KB or smaller`)
  }
  if (ext === 'svg') refuseUnsafeSvg(f.bytes, what)
}

function checkColour(v: string | null | undefined, what: string): string | undefined {
  if (v === null || v === undefined) return undefined
  const s = v.trim()
  if (!s) return ''
  if (!HEX_COLOUR.test(s)) {
    throw new OperationRefused('brand_colour', `the ${what} colour must be a hex value like #0A3A78`)
  }
  return s.toUpperCase()
}

async function currentValue(): Promise<BrandingValue> {
  const r = await getPool().query(
    `select value from deedbox.config_slot where slot = 'branding' and entry_key = $1`,
    [BRAND_ENTRY_KEY],
  )
  return r.rowCount === 0 ? {} : (r.rows[0].value as BrandingValue)
}

/**
 * Set (or partially update) the installation's brand. Fields left undefined
 * are kept; a field given as null or empty is cleared back to the default.
 * Files are stored BYTES-FIRST in the installation's own object storage,
 * then the slot is written inside the registered operation.
 */
export async function setBranding(p: Principal, input: SetBrandingInput): Promise<{ value: BrandingValue }> {
  requireStaff(p)
  // the same gate set_config_slot applies — checked FIRST so a refused caller
  // never leaves an orphaned logo file in storage
  await withPrincipal(
    p,
    async (tx) => {
      const ok =
        (await hasCapability(tx, p.id, 'private_layer.manage')) ||
        (await hasCapability(tx, p.id, 'security.administer'))
      if (!ok) throw new OperationRefused('capability_missing', 'branding needs security.administer')
    },
    { readOnly: true },
  )
  const next: BrandingValue = { ...(await currentValue()) }

  if (input.displayName !== undefined) {
    const name = (input.displayName ?? '').trim()
    if (name.length > NAME_MAX) {
      throw new OperationRefused('brand_name_length', `the display name must be ${NAME_MAX} characters or fewer`)
    }
    if (name && name !== PRODUCT_NAME) next.display_name = name
    else delete next.display_name
  }
  const cp = checkColour(input.colourPrimary, 'primary')
  if (cp !== undefined) {
    if (cp) next.colour_primary = cp
    else delete next.colour_primary
  }
  const cs = checkColour(input.colourSecondary, 'secondary')
  if (cs !== undefined) {
    if (cs) next.colour_secondary = cs
    else delete next.colour_secondary
  }

  if (input.logo !== undefined) {
    if (input.logo === null) delete next.logo
    else {
      checkFile(input.logo, 'logo')
      const stored = await requireByteStore()({ matter: null, filename: `brand-logo.${extensionOf(input.logo.filename)}`, bytes: input.logo.bytes })
      next.logo = stored.storageRef
    }
  }
  if (input.icon !== undefined) {
    if (input.icon === null) delete next.icon
    else {
      checkFile(input.icon, 'icon')
      const stored = await requireByteStore()({ matter: null, filename: `brand-icon.${extensionOf(input.icon.filename)}`, bytes: input.icon.bytes })
      next.icon = stored.storageRef
    }
  }

  await setConfigSlot(p, { slot: 'branding', entryKey: BRAND_ENTRY_KEY, value: next as Record<string, unknown> })
  return { value: next }
}

/**
 * Back to the product default: name, files and colours all cleared (the
 * register keeps the before/after). Choosing the default IS a decision, so
 * the installation stops being asked.
 */
export async function resetBranding(p: Principal): Promise<void> {
  requireStaff(p)
  await setConfigSlot(p, {
    slot: 'branding',
    entryKey: BRAND_ENTRY_KEY,
    value: { choice: KEEP_DEFAULT_CHOICE },
  })
}

/** "Leave it as it is": keep the product's own look and record that it was chosen. */
export async function keepDefaultBranding(p: Principal): Promise<void> {
  requireStaff(p)
  const next: BrandingValue = { ...(await currentValue()), choice: KEEP_DEFAULT_CHOICE }
  await setConfigSlot(p, { slot: 'branding', entryKey: BRAND_ENTRY_KEY, value: next as Record<string, unknown> })
}
