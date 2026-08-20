// Firm-added navigation links (0057): the parser and the merge are pure —
// the menu must never break the shell, so every malformed shape degrades to
// "no extra link", never to an error.

import { describe, it, expect } from 'vitest'
import { parseFirmNavLinks, mergeNavGroups, type NavGroup } from '@/lib/navLinks'

describe('parseFirmNavLinks', () => {
  it('reads one link per line with optional capabilities', () => {
    const got = parseFirmNavLinks(
      'Billing | Fee distributions | /fee-distributions | security.administer, money.manage_accounts\n' +
        'Tools | Old reports | /tools/old-reports\n',
    )
    expect(got).toEqual([
      {
        section: 'Billing',
        items: [
          {
            href: '/fee-distributions',
            label: 'Fee distributions',
            caps: ['security.administer', 'money.manage_accounts'],
          },
        ],
      },
      { section: 'Tools', items: [{ href: '/tools/old-reports', label: 'Old reports' }] },
    ])
  })

  it('groups repeated sections in first-appearance order', () => {
    const got = parseFirmNavLinks('A | one | /1\nB | two | /2\nA | three | /3')
    expect(got.map((g) => g.section)).toEqual(['A', 'B'])
    expect(got[0].items.map((i) => i.href)).toEqual(['/1', '/3'])
  })

  it('skips blanks, comments and every malformed shape', () => {
    const got = parseFirmNavLinks(
      [
        '',
        '# a comment',
        'only-two | parts',
        'Sec | Label | not-internal',
        'Sec | Label | https://elsewhere.example/x',
        ' | Label | /missing-section',
        'Sec |  | /missing-label',
        'Sec | Ok | /ok | a | too-many',
        'Sec | Fine | /fine',
      ].join('\n'),
    )
    expect(got).toEqual([{ section: 'Sec', items: [{ href: '/fine', label: 'Fine' }] }])
  })

  it('an empty or absent value yields no groups', () => {
    expect(parseFirmNavLinks('')).toEqual([])
    expect(parseFirmNavLinks('   \n  \n')).toEqual([])
  })
})

describe('mergeNavGroups', () => {
  const base: NavGroup[] = [
    { section: 'Work', items: [{ href: '/', label: 'Home' }] },
    { section: 'Billing', items: [{ href: '/billing', label: 'My time' }] },
  ]

  it('appends firm items to a same-named section and new sections at the end', () => {
    const merged = mergeNavGroups(base, [
      { section: 'Billing', items: [{ href: '/fee-distributions', label: 'Fee distributions' }] },
      { section: 'Firm tools', items: [{ href: '/tools', label: 'Tools' }] },
    ])
    expect(merged.map((g) => g.section)).toEqual(['Work', 'Billing', 'Firm tools'])
    expect(merged[1].items.map((i) => i.href)).toEqual(['/billing', '/fee-distributions'])
  })

  it('never duplicates an href already shipped in the section', () => {
    const merged = mergeNavGroups(base, [
      { section: 'Billing', items: [{ href: '/billing', label: 'Renamed attempt' }] },
    ])
    expect(merged[1].items).toEqual([{ href: '/billing', label: 'My time' }])
  })

  it('leaves the shipped array untouched', () => {
    mergeNavGroups(base, [{ section: 'Billing', items: [{ href: '/x', label: 'X' }] }])
    expect(base[1].items).toHaveLength(1)
  })
})
