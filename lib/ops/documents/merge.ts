// The template merge engine. Templates use << >> merge tags with dotted,
// capitalised paths; lowercase aliases remain populated; missing
// fields render BLANK, never the word "undefined".
//
// Preferred tags: Matter.Summary for the matter summary, and
// Matter.ResponsibleLawyer.* for the responsible lawyer. Alternative
// spellings — Matter.CustomField.CostAgreementScopeOfWorks,
// Matter.ResponsibleAttorney, Matter.ResponsibleStaff, and
// Address.ZipCode beside Postcode — stay populated as deprecated aliases
// so existing templates keep rendering. New templates should use the
// preferred tags.

import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'
import type { Tx } from '@/lib/db'
import { OperationRefused } from '@/lib/db'
import { MERGE_DATE_LOCALE, ISO_DATE_LOCALE } from '@/lib/format'

function fmtDate(iso: string | null, timezone: string, long = false): string {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return ''
  return long
    ? d.toLocaleDateString(MERGE_DATE_LOCALE, { day: 'numeric', month: 'long', year: 'numeric', timeZone: timezone })
    : d.toLocaleDateString(MERGE_DATE_LOCALE, { timeZone: timezone })
}

function todayIso(timezone: string): string {
  return new Intl.DateTimeFormat(ISO_DATE_LOCALE, { timeZone: timezone }).format(new Date())
}

/** Assemble the merge data for one matter from the new schema. */
export async function buildMergeData(
  tx: Tx,
  matterId: number,
  timezone: string,
): Promise<Record<string, unknown>> {
  const m = await tx.query(
    `select m.id, m.matter_number, m.title, m.summary, m.jurisdiction, m.opened_date,
            m.client_party, m.responsible_lawyer, m.office,
            pa.name as practice_area
       from deedbox.matter m
       join deedbox.practice_area pa on pa.id = m.practice_area
      where m.id = $1`,
    [matterId],
  )
  if (m.rowCount === 0) throw new OperationRefused('not_found', 'no matter by that id')
  const mt = m.rows[0]

  const [nameRes, contactsRes, addressRes, lawyerRes, officeRes, partyRes] = await Promise.all([
    tx.query(
      `select full_name from deedbox.party_name where party = $1 and name_kind = 'current' limit 1`,
      [mt.client_party],
    ),
    tx.query(
      `select kind, value from deedbox.contact_point
        where party = $1 and deleted_at is null
        order by is_primary desc, id`,
      [mt.client_party],
    ),
    tx.query(
      `select lines, locality, region, postcode from deedbox.postal_address
        where party = $1 and current and deleted_at is null
        order by id limit 1`,
      [mt.client_party],
    ),
    tx.query(
      `select s.person_name, s.email, r.name as role_name
         from deedbox.staff_member s join deedbox.role r on r.id = s.role
        where s.id = $1`,
      [mt.responsible_lawyer],
    ),
    tx.query(`select name, address from deedbox.office where id = $1`, [mt.office]),
    tx.query(
      `select p2.display_name, coalesce(ci.label, '') as capacity,
              (select value from deedbox.contact_point cp
                where cp.party = p2.id and cp.kind = 'email' and cp.deleted_at is null
                order by cp.is_primary desc, cp.id limit 1) as email
         from deedbox.matter_party mp
         join deedbox.party p2 on p2.id = mp.party
         left join deedbox.choice_item ci on ci.id = mp.capacity
        where mp.matter = $1 and mp.deleted_at is null and mp.party <> $2
        order by mp.id limit 1`,
      [matterId, mt.client_party],
    ),
  ])

  const clientFullName = (nameRes.rows[0]?.full_name as string | undefined) ?? ''
  const parts = clientFullName.trim().split(/\s+/).filter(Boolean)
  const clientFirstName = parts[0] ?? ''
  const clientLastName = parts.length > 1 ? parts.slice(1).join(' ') : ''
  const clientEmail =
    (contactsRes.rows.find((c) => c.kind === 'email')?.value as string | undefined) ?? ''
  const clientPhone =
    (contactsRes.rows.find((c) => c.kind === 'phone')?.value as string | undefined) ?? ''
  const addr = addressRes.rows[0] ?? {}
  const clientAddress = {
    Street: (addr.lines as string | null) ?? '',
    City: (addr.locality as string | null) ?? '',
    State: (addr.region as string | null) ?? '',
    Postcode: (addr.postcode as string | null) ?? '',
    ZipCode: (addr.postcode as string | null) ?? '', // deprecated alias
  }
  const lawyerName = lawyerRes.rows[0]
    ? `${(lawyerRes.rows[0].person_name as { given?: string })?.given ?? ''} ${
        (lawyerRes.rows[0].person_name as { family?: string })?.family ?? ''
      }`.trim()
    : ''
  const responsible = {
    Name: lawyerName,
    Email: (lawyerRes.rows[0]?.email as string | undefined) ?? '',
    JobTitle: { Name: (lawyerRes.rows[0]?.role_name as string | undefined) ?? '' },
  }
  const officeAddress = officeRes.rows[0]?.address
    ? Object.values(officeRes.rows[0].address as Record<string, unknown>)
        .filter((v) => typeof v === 'string' && v)
        .join(' ')
    : ''
  const today = todayIso(timezone)

  return {
    Date: { Verbose: fmtDate(today, timezone, true) },
    Matter: {
      Number: (mt.matter_number as string) ?? '',
      Title: (mt.title as string) ?? '',
      Summary: (mt.summary as string | null) ?? '', // preferred tag
      Client: {
        Name: clientFullName,
        FirstName: clientFirstName,
        LastName: clientLastName,
        Email: clientEmail,
        Address: clientAddress,
      },
      ResponsibleLawyer: responsible, // preferred tag
      ResponsibleAttorney: responsible, // deprecated alias
      ResponsibleStaff: responsible, // deprecated alias
      CustomField: { CostAgreementScopeOfWorks: (mt.summary as string | null) ?? '' }, // deprecated alias
    },
    client: {
      name: clientFullName,
      first_name: clientFirstName,
      last_name: clientLastName,
      email: clientEmail,
      phone: clientPhone,
      address: [clientAddress.Street, clientAddress.City, clientAddress.State, clientAddress.Postcode]
        .filter(Boolean)
        .join(', '),
      street: clientAddress.Street,
      city: clientAddress.City,
      state: clientAddress.State,
      postcode: clientAddress.Postcode,
    },
    matter: {
      name: (mt.matter_number as string) ?? '',
      number: (mt.matter_number as string) ?? '',
      title: (mt.title as string) ?? '',
      opened: fmtDate(mt.opened_date ? String(mt.opened_date).slice(0, 10) : null, timezone),
      opened_long: fmtDate(mt.opened_date ? String(mt.opened_date).slice(0, 10) : null, timezone, true),
      type: (mt.practice_area as string) ?? '',
      jurisdiction: (mt.jurisdiction as string | null) ?? '',
      summary: (mt.summary as string | null) ?? '',
    },
    manager: { name: responsible.Name, email: responsible.Email, title: responsible.JobTitle.Name },
    office: { name: (officeRes.rows[0]?.name as string | undefined) ?? '', address: officeAddress },
    other_party: {
      name: (partyRes.rows[0]?.display_name as string | undefined) ?? '',
      role: (partyRes.rows[0]?.capacity as string | undefined) ?? '',
      email: (partyRes.rows[0]?.email as string | undefined) ?? '',
    },
    today: fmtDate(today, timezone),
    today_long: fmtDate(today, timezone, true),
  }
}

/** Render a Word template's bytes with the merge data. Typed on failure. */
export function renderTemplate(templateBytes: Buffer, data: Record<string, unknown>): Buffer {
  try {
    const zip = new PizZip(templateBytes)
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      // templates use << >> merge tags (dotted, capitalised paths)
      delimiters: { start: '<<', end: '>>' },
      // resolve dotted paths; docxtemplater's default parser only matches a
      // literal top-level key
      parser: (tag: string) => ({
        get: (scope: unknown) =>
          tag
            .trim()
            .split('.')
            .reduce(
              (o: unknown, k: string) =>
                o == null ? undefined : (o as Record<string, unknown>)[k.trim()],
              scope,
            ),
      }),
      // genuinely-missing fields render blank
      nullGetter: () => '',
    })
    doc.render(data)
    return Buffer.from(doc.getZip().generate({ type: 'uint8array' }) as Uint8Array)
  } catch (e) {
    const detail =
      (e as { properties?: { errors?: unknown } }).properties?.errors !== undefined
        ? JSON.stringify((e as { properties: { errors: unknown } }).properties.errors).slice(0, 300)
        : String((e as Error).message ?? e).slice(0, 300)
    throw new OperationRefused('template_render_failed', `the template did not render: ${detail}`)
  }
}
