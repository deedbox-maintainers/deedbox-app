// Regional formatting — the ONE home of locale, currency and paper-size
// conventions. The country lint (tests/app/country.test.ts) bans these
// literals everywhere else, exactly as the brand lint keeps the product's
// identity inside lib/brand.ts: a jurisdiction-neutral engine may carry
// regional conventions in one declared place only.
//
// The shipped compatibility defaults reproduce the product's historical
// rendering (Australian-English formatting, A4 paper) so an installation
// that sets nothing sees exactly the documents and screens it always saw.
// Per-firm truth beats the defaults wherever it exists: client-facing money
// takes the firm's own operating_currency (mandatory on deedbox.firm since
// the first schema change), enriched into each document's stored rendering
// at queue time so the preview and the delivered copy can never diverge.

export interface Regional {
  /** ISO 4217 currency code, e.g. AUD. */
  currency: string
  /** BCP 47 locale used to render numbers and dates, e.g. en-AU. */
  locale: string
}

/** The shipped compatibility defaults — a deliberate, documented choice. */
export const COMPATIBILITY_REGIONAL: Regional = { currency: 'AUD', locale: 'en-AU' }

/** Staff-screen display locale (dates and times on internal screens). */
export const DISPLAY_LOCALE = COMPATIBILITY_REGIONAL.locale

/** Long-form dates inside merged documents (day month year order). */
export const MERGE_DATE_LOCALE = 'en-GB'

/** The standard Intl trick for an ISO yyyy-mm-dd string. */
export const ISO_DATE_LOCALE = 'en-CA'

/** Generated documents' paper size — a documented engine decision. */
export const DOCUMENT_PAGE_SIZE = 'A4'

/**
 * Resolve a rendering's enriched regional block. Old renderings (queued
 * before enrichment existed) carry none and fall back to the compatibility
 * defaults, which reproduce their original appearance.
 */
export function regionalFrom(v: unknown): Regional {
  const r = (v ?? {}) as Partial<Regional>
  return {
    currency:
      typeof r.currency === 'string' && /^[A-Z]{3}$/.test(r.currency)
        ? r.currency
        : COMPATIBILITY_REGIONAL.currency,
    locale:
      typeof r.locale === 'string' && r.locale.length >= 2
        ? r.locale
        : COMPATIBILITY_REGIONAL.locale,
  }
}

/**
 * Money on client-facing documents: the firm's own currency, always two
 * decimal places (the engine's money columns are two-decimal by design —
 * a documented limitation for zero- and three-decimal currencies).
 */
export function formatMoney(n: unknown, regional?: Partial<Regional> | null): string {
  const r = regionalFrom(regional)
  const v = Number(n ?? 0)
  return new Intl.NumberFormat(r.locale, {
    style: 'currency',
    currency: r.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(v) ? v : 0)
}
