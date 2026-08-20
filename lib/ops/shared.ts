import type { Principal, Tx } from '@/lib/db'
import { OperationRefused } from '@/lib/db'
import { COMPATIBILITY_REGIONAL } from '@/lib/format'

/** Ordinary staff work: refuse every other principal kind with a typed message. */
export function requireStaff(p: Principal): void {
  if (p.kind !== 'staff') {
    throw new OperationRefused('staff_only', 'this operation is performed by staff')
  }
}

/**
 * Capability check against the acting staff member's role grants (0003).
 * A scope of 'none' is an explicit removal and does not satisfy the check.
 */
export async function hasCapability(tx: Tx, staffId: number, key: string): Promise<boolean> {
  const r = await tx.query(
    `select exists (
       select 1
         from deedbox.staff_member s
         join deedbox.role r on r.id = s.role and r.active
         join deedbox.role_capability rc on rc.role = s.role
        where s.id = $1 and s.active and rc.capability = $2 and rc.scope <> 'none'
     ) as ok`,
    [staffId, key],
  )
  return r.rows[0].ok as boolean
}

export async function requireCapability(tx: Tx, p: Principal, key: string): Promise<void> {
  requireStaff(p)
  if (!(await hasCapability(tx, p.id, key))) {
    throw new OperationRefused('capability_missing', `this operation requires ${key}`)
  }
}

/** The setting in force, as text (effective-dated history, neutral default fallback). */
export async function settingText(tx: Tx, key: string): Promise<string | null> {
  const r = await tx.query(
    `select deedbox.current_setting_value($1) #>> '{}' as v`,
    [key],
  )
  return r.rows[0].v as string | null
}

export async function settingBool(tx: Tx, key: string): Promise<boolean> {
  return (await settingText(tx, key)) === 'true'
}

/**
 * Money's has-ledger read: is this party the client
 * on any ledger-bearing matter? Drives master_data.changed emission.
 *
 * Implementation note: this read joins matter and
 * is therefore subject to the acting staff member's visibility predicate; a
 * restricted ledger-bearing matter invisible to the actor is missed. The
 * money-domain definer helper that closes this pinhole lands with the money
 * operations slice via a numbered schema change.
 */
export async function clientOnLedgerBearingMatter(tx: Tx, partyId: number): Promise<boolean> {
  const r = await tx.query(
    `select exists (
       select 1 from deedbox.matter m
         join deedbox.matter_ledger ml on ml.matter = m.id
        where m.client_party = $1
     ) as ok`,
    [partyId],
  )
  return r.rows[0].ok as boolean
}

/**
 * A single string declared by the firm's ACTIVE pack version against a rule
 * point (a `value` or `string_bundle` declaration whose body carries
 * {"value": "..."}). Null when the pack is silent — the caller supplies the
 * engine's neutral wording. This is the minimal live consumer of the
 * strings.* seam: pack wording beats engine wording, one key at a time.
 */
export async function packString(tx: Tx, firm: number, rulePoint: string): Promise<string | null> {
  const r = await tx.query(
    `select d.body->>'value' as v
       from deedbox.pack_declaration d
       join deedbox.firm f on f.id = $1
       join deedbox.country_pack cp on cp.id = f.country_pack
      where d.pack_version = cp.active_version and d.rule_point = $2
      limit 1`,
    [firm, rulePoint],
  )
  const v = r.rows[0]?.v as string | undefined
  return v && v.trim() !== '' ? v : null
}

/**
 * The firm's regional facts for client-facing rendering: its own
 * operating currency (mandatory since the first schema change) plus the
 * display locale (the compatibility default until a firm-level locale
 * exists). Enrich this into a document's stored rendering at queue time.
 */
export async function firmRegional(
  tx: Tx,
  firm: number,
): Promise<{ currency: string; locale: string }> {
  const r = await tx.query(`select operating_currency from deedbox.firm where id = $1`, [firm])
  const currency = (r.rows[0]?.operating_currency as string | undefined) ?? ''
  return {
    currency: /^[A-Z]{3}$/.test(currency) ? currency : COMPATIBILITY_REGIONAL.currency,
    locale: COMPATIBILITY_REGIONAL.locale,
  }
}

/**
 * The firm's trading identity for outbound documents: legal name, trading
 * address and registration number are firm settings (empty until the firm
 * fills them); what the registration number is CALLED comes from the pack
 * (strings.registration_label — e.g. a national business-number label), with
 * a neutral fallback. All-or-nothing per field: an empty field is absent.
 */
export async function firmIdentity(
  tx: Tx,
  firm: number,
): Promise<{
  legal_name: string | null
  address: string | null
  registration_label: string | null
  registration_number: string | null
}> {
  const legal = ((await settingText(tx, 'firm.legal_name')) ?? '').trim()
  const address = ((await settingText(tx, 'firm.trading_address')) ?? '').trim()
  const regNo = ((await settingText(tx, 'firm.registration_number')) ?? '').trim()
  const regLabel = regNo !== '' ? ((await packString(tx, firm, 'strings.registration_label')) ?? 'Registration no.') : null
  return {
    legal_name: legal !== '' ? legal : null,
    address: address !== '' ? address : null,
    registration_label: regLabel,
    registration_number: regNo !== '' ? regNo : null,
  }
}

/** The active pack's declared bank-identifier field keys (bank.account_identifiers), if any. */
export async function bankIdentifierKeys(tx: Tx, firm: number): Promise<string[] | null> {
  const r = await tx.query(
    `select d.body from deedbox.pack_declaration d
       join deedbox.firm f on f.id = $1
       join deedbox.country_pack cp on cp.id = f.country_pack
       join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
      where d.rule_point = 'bank.account_identifiers'`,
    [firm],
  )
  for (const row of r.rows) {
    const b = row.body as { fields?: { key: string }[] }
    if (b.fields && b.fields.length > 0) return b.fields.map((f) => f.key)
  }
  return null
}

export interface TaxTreatment {
  key: string
  label: string
  rate: number
  isDefault: boolean
}

/**
 * The ACTIVE pack's declared tax treatments (billing.tax enumerations), in
 * display order: the declared default first, then by key. Empty when the
 * pack is silent — the engine then computes no tax and shows no choice.
 * Screens render the CHOICE from these declarations (value = the pack's own
 * discriminator, caption = the pack's own label) so no engine surface ever
 * carries a country's tax vocabulary.
 */
export async function taxTreatments(tx: Tx, firm: number): Promise<TaxTreatment[]> {
  const r = await tx.query(
    `select d.discriminator as key, d.body
       from deedbox.pack_declaration d
       join deedbox.firm f on f.id = $1
       join deedbox.country_pack cp on cp.id = f.country_pack
      where d.pack_version = cp.active_version
        and d.rule_point = 'billing.tax' and d.kind = 'enumeration'
        and d.discriminator is not null
      order by d.discriminator`,
    [firm],
  )
  const all = r.rows.map((row) => {
    const b = (row.body ?? {}) as { label?: string; rate?: number; default?: boolean }
    return {
      key: row.key as string,
      label: b.label ?? (row.key as string),
      rate: Number(b.rate ?? 0),
      isDefault: b.default === true,
    }
  })
  // Exactly one default, always: the pack's flagged declaration; else the
  // key literally named 'standard' where declared (every pre-flag pack's
  // base treatment — behaviour-preserving for existing installations); else
  // the first. The default leads the list so forms preselect it.
  if (all.length > 0 && !all.some((t) => t.isDefault)) {
    const fallback = all.find((t) => t.key === 'standard') ?? all[0]
    fallback.isDefault = true
  }
  all.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.key.localeCompare(b.key))
  return all
}

/**
 * The treatment applied when the caller names none: the pack's default per
 * taxTreatments — and 'standard' when no pack governs (any key is then
 * valid and no tax is computed).
 */
export async function defaultTaxTreatment(tx: Tx, firm: number): Promise<string> {
  const all = await taxTreatments(tx, firm)
  if (all.length === 0) return 'standard'
  return (all.find((t) => t.isDefault) ?? all[0]).key
}

/** The active choice item for a shipped key in a purpose-keyed list. */
export async function shippedChoiceItem(
  tx: Tx,
  purposeKey: string,
  shippedKey: string,
): Promise<number> {
  const r = await tx.query(
    `select ci.id from deedbox.choice_item ci
       join deedbox.choice_list cl on cl.id = ci.list
      where cl.purpose_key = $1 and ci.shipped_key = $2`,
    [purposeKey, shippedKey],
  )
  if (r.rowCount !== 1) {
    throw new OperationRefused(
      'choice_item_missing',
      `no shipped item ${shippedKey} in list ${purposeKey}`,
    )
  }
  return r.rows[0].id as number
}
