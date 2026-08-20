// The installation's brand: what this DeedBox installation calls itself and
// what it shows for a logo, browser-tab icon and colours.
//
// Every installation is DeedBox by default. A firm may white-label it — its
// own name, its own logo and icon (uploaded once, stored in the
// installation's own object storage), its own two colours — through the
// `branding` configuration slot (Configuration → Firm settings → Branding),
// and every product surface reads THIS module rather than carrying the
// product's name or artwork itself. That keeps the engine free of any firm's
// identity and lets any firm re-skin without an engine change.
//
// This is an instance-level read (one firm per installation), needed by
// pages that have no signed-in principal (sign-in, the browser tab), so it
// reads through the runtime pool like theFirm() does. It must never make a
// page fail: any problem reading the slot yields the DeedBox default.

import { getPool } from '@/lib/db'

export const PRODUCT_NAME = 'DeedBox'
export const DEFAULT_LOGO_HREF = '/deedbox-lockup.svg'
export const DEFAULT_ICON_HREF = '/deedbox-icon.svg'
export const BRAND_ENTRY_KEY = 'default'

export interface Brand {
  /** What the installation is called on every surface. */
  name: string
  /** The lockup shown in the header and on the sign-in card. */
  logoHref: string
  /** The browser-tab / bookmark icon. */
  iconHref: string
  colourPrimary: string | null
  colourSecondary: string | null
  /** True when nothing has been set — the installation looks like DeedBox. */
  isDefault: boolean
  /** True once an administrator has either branded the installation or chosen to keep the default. */
  decided: boolean
  /** The stored object references, when the firm uploaded its own files. */
  logoRef: string | null
  iconRef: string | null
}

export const DEFAULT_BRAND: Brand = {
  name: PRODUCT_NAME,
  logoHref: DEFAULT_LOGO_HREF,
  iconHref: DEFAULT_ICON_HREF,
  colourPrimary: null,
  colourSecondary: null,
  isDefault: true,
  decided: false,
  logoRef: null,
  iconRef: null,
}

/** The value the branding slot records when the firm chooses to keep the DeedBox look. */
export const KEEP_DEFAULT_CHOICE = 'keep_default'

export interface BrandingValue {
  display_name?: string
  logo?: string
  icon?: string
  colour_primary?: string
  colour_secondary?: string
  /** 'keep_default' once the firm has chosen to stay with the DeedBox look. */
  choice?: string
}

/** A short cache-busting tag so a re-uploaded logo shows without a stale cache. */
function tag(ref: string): string {
  let h = 0
  for (let i = 0; i < ref.length; i++) h = (h * 31 + ref.charCodeAt(i)) >>> 0
  return h.toString(36)
}

export function brandFromValue(v: BrandingValue | null | undefined): Brand {
  if (!v) return DEFAULT_BRAND
  const name = typeof v.display_name === 'string' && v.display_name.trim() ? v.display_name.trim() : PRODUCT_NAME
  const logoRef = typeof v.logo === 'string' && v.logo.trim() ? v.logo.trim() : null
  const iconRef = typeof v.icon === 'string' && v.icon.trim() ? v.icon.trim() : null
  const colourPrimary = typeof v.colour_primary === 'string' && v.colour_primary.trim() ? v.colour_primary.trim() : null
  const colourSecondary =
    typeof v.colour_secondary === 'string' && v.colour_secondary.trim() ? v.colour_secondary.trim() : null
  const isDefault = name === PRODUCT_NAME && !logoRef && !iconRef && !colourPrimary && !colourSecondary
  const decided = !isDefault || v.choice === KEEP_DEFAULT_CHOICE
  return {
    name,
    logoHref: logoRef ? `/brand/logo?v=${tag(logoRef)}` : DEFAULT_LOGO_HREF,
    iconHref: iconRef ? `/brand/icon?v=${tag(iconRef)}` : DEFAULT_ICON_HREF,
    colourPrimary,
    colourSecondary,
    isDefault,
    decided,
    logoRef,
    iconRef,
  }
}

/** The installation's brand, or the DeedBox default if none is set or the read fails. */
export async function readBrand(): Promise<Brand> {
  try {
    const r = await getPool().query(
      `select value from deedbox.config_slot where slot = 'branding' and entry_key = $1`,
      [BRAND_ENTRY_KEY],
    )
    if (r.rowCount === 0) return DEFAULT_BRAND
    return brandFromValue(r.rows[0].value as BrandingValue)
  } catch {
    return DEFAULT_BRAND
  }
}

/** Inline CSS custom properties for the root element; empty when the firm set no colours. */
export function brandCssVars(b: Brand): Record<string, string> {
  const vars: Record<string, string> = {}
  if (b.colourPrimary) vars['--brand-primary'] = b.colourPrimary
  if (b.colourSecondary) vars['--brand-secondary'] = b.colourSecondary
  return vars
}
