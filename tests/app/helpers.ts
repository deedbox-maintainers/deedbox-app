import { Pool } from 'pg'
// Importing the pool module applies its global int8 → number parser to every
// pg connection in the process, including the admin pool below.
import '@/lib/db/pool'

/**
 * Fixture/verification pool: connects as the scratch database's owning login
 * role WITHOUT stepping down to deedbox_app, so it bypasses row security and
 * can build fixtures and read evidence directly. Never used by code under
 * test — the plumbing under test steps down inside its own transactions.
 */
export function makeAdminPool(): Pool {
  const url = process.env.DEEDBOX_DATABASE_URL
  if (!url) throw new Error('DEEDBOX_DATABASE_URL is not set')
  return new Pool({
    connectionString: url,
    max: 2,
    ssl:
      process.env.DEEDBOX_DATABASE_SSL === 'disable'
        ? undefined
        : { rejectUnauthorized: false },
  })
}

export interface Fixture {
  firm: number
  office: number
  adminRole: number
  staff: number
  clientParty: number
  practiceArea: number
  matter: number
  account: number
  ledger: number
  approvedAuthorisation: number
}

/**
 * The minimal world a test file acts in: one firm, one office, one
 * administrator, one client with one open matter, one pooled client account
 * with the matter's ledger, and one approved payment authorisation whose
 * subject id sits far above anything real: placeholder subjects must
 * never collide with real ids. The tag keeps each test file's
 * fixture clear of the others' unique indexes on one shared scratch database.
 */
export async function buildFixture(admin: Pool, tag = 'plumb'): Promise<Fixture> {
  const cp = await admin.query(
    `insert into deedbox.country_pack (code, name) values ($1, $2) returning id`,
    [`x${tag.slice(0, 3)}`, `Neutral Test Pack ${tag}`],
  )
  const firm = await admin.query(
    `insert into deedbox.firm (name, operating_currency, timezone, country_pack)
     values ($2, 'AUD', 'Australia/Sydney', $1) returning id`,
    [cp.rows[0].id, `Test Firm ${tag}`],
  )
  const office = await admin.query(
    `insert into deedbox.office (name, code) values ($1, $2) returning id`,
    [`Office ${tag}`, tag.toUpperCase()],
  )
  const adminRole = await admin.query(
    `select id from deedbox.role where system_key = 'administrator'`,
  )
  const staff = await admin.query(
    `insert into deedbox.staff_member (person_name, login, role, office, email)
     values ('{"given":"Pat","family":"Tester"}', $3, $1, $2, $4)
     returning id`,
    [adminRole.rows[0].id, office.rows[0].id, `pat.${tag}`, `pat.${tag}@example.test`],
  )
  const party = await admin.query(
    `insert into deedbox.party (kind, display_name) values ('person', $1) returning id`,
    [`Fixture Client ${tag}`],
  )
  // real creation always writes the current name row — the match-key
  // machinery hangs off it, so the fixture stays truthful to production shape
  await admin.query(
    `insert into deedbox.party_name (party, name_kind, full_name)
     values ($1, 'current', $2)`,
    [party.rows[0].id, `Fixture Client ${tag}`],
  )
  const area = await admin.query(
    `insert into deedbox.practice_area (name) values ($1) returning id`,
    [`General ${tag}`],
  )
  const matter = await admin.query(
    `insert into deedbox.matter
       (matter_number, title, client_party, responsible_lawyer, office, practice_area)
     values ($5, $6, $1, $2, $3, $4) returning id`,
    [
      party.rows[0].id,
      staff.rows[0].id,
      office.rows[0].id,
      area.rows[0].id,
      `T-${tag}-000001`,
      `Fixture Matter ${tag}`,
    ],
  )
  const account = await admin.query(
    `insert into deedbox.client_account (name, account_kind) values ($1, 'pooled') returning id`,
    [`Trust ${tag}`],
  )
  const ledger = await admin.query(
    `insert into deedbox.matter_ledger (account, matter) values ($1, $2) returning id`,
    [account.rows[0].id, matter.rows[0].id],
  )
  const auth = await admin.query(
    `insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision)
     values ('money_payment', 900002, $1, 'approved') returning id`,
    [staff.rows[0].id],
  )
  return {
    firm: firm.rows[0].id,
    office: office.rows[0].id,
    adminRole: adminRole.rows[0].id,
    staff: staff.rows[0].id,
    clientParty: party.rows[0].id,
    practiceArea: area.rows[0].id,
    matter: matter.rows[0].id,
    account: account.rows[0].id,
    ledger: ledger.rows[0].id,
    approvedAuthorisation: auth.rows[0].id,
  }
}

/** A second active administrator (approver-separation tests). */
export async function addStaff(admin: Pool, fx: Fixture, login: string): Promise<number> {
  const r = await admin.query(
    `insert into deedbox.staff_member (person_name, login, role, office, email)
     values ('{"given":"Sam","family":"Second"}', $1, $2, $3, $4) returning id`,
    [login, fx.adminRole, fx.office, `${login}@example.test`],
  )
  return r.rows[0].id as number
}

/**
 * A firm setting taking effect in the past — now() is frozen per transaction,
 * so a row effective "now" is not yet in force inside the same-instant reads
 * Settings history is append-only and database-global:
 * tests that flip one must append a later counter-row afterwards.
 */
export async function setFirmSetting(
  admin: Pool,
  key: string,
  value: unknown,
  minutesAgo: number,
): Promise<void> {
  await admin.query(
    `insert into deedbox.firm_setting (definition, value, effective_from)
     select sd.id, $1::jsonb, now() - make_interval(mins => $2)
       from deedbox.setting_definition sd where sd.key = $3`,
    [JSON.stringify(value), minutesAgo, key],
  )
}
