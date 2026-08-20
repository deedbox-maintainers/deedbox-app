// Firm-added navigation links (setting `nav.firm_links`, change 0057).
//
// An installation's own screens — private-layer pages, instance tooling —
// earn a place on the menu through one plain-text setting, one link per line:
//
//     Section | Label | /path | capability,capability
//
// The section joins a shipped menu group by exact name, or becomes a new
// group after the shipped ones. Capabilities are optional and filter display
// exactly like shipped items. Paths must be internal (start with '/').
// A malformed line is skipped: the menu must never break the shell, and the
// setting is display-only convenience — every screen checks for itself.

export interface NavItem {
  href: string
  label: string
  /** show when the viewer holds ANY of these; absent = everyone */
  caps?: string[]
}

export interface NavGroup {
  section: string
  items: NavItem[]
}

/** Parse the setting's text into groups; malformed lines are skipped. */
export function parseFirmNavLinks(text: string): NavGroup[] {
  const groups: NavGroup[] = []
  const byName = new Map<string, NavGroup>()
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split('|').map((s) => s.trim())
    if (parts.length < 3 || parts.length > 4) continue
    const [section, label, href, capsRaw] = parts
    if (!section || !label || !href.startsWith('/')) continue
    const caps = (capsRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const item: NavItem = caps.length > 0 ? { href, label, caps } : { href, label }
    let g = byName.get(section)
    if (!g) {
      g = { section, items: [] }
      byName.set(section, g)
      groups.push(g)
    }
    g.items.push(item)
  }
  return groups
}

/**
 * Merge firm groups into the shipped menu: same-named sections gain the
 * firm's items (shipped items first; duplicate hrefs skipped), unknown
 * sections follow the shipped ones. The shipped array is never mutated.
 */
export function mergeNavGroups(base: NavGroup[], extra: NavGroup[]): NavGroup[] {
  const merged: NavGroup[] = base.map((g) => ({ section: g.section, items: [...g.items] }))
  const byName = new Map(merged.map((g) => [g.section, g]))
  for (const g of extra) {
    const target = byName.get(g.section)
    if (!target) {
      const fresh = { section: g.section, items: [...g.items] }
      byName.set(g.section, fresh)
      merged.push(fresh)
      continue
    }
    for (const item of g.items) {
      if (target.items.some((i) => i.href === item.href)) continue
      target.items.push(item)
    }
  }
  return merged
}
