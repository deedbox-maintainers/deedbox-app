'use server'

// Integration-key actions: issue (the secret is shown exactly once — only
// its hash is stored), revoke (immediate), and the per-key activity export.

import { act } from '@/lib/screens/action'
import {
  issueIntegrationKey,
  revokeIntegrationKey,
  exportKeyActivity,
  setIntakeKeyDefaults,
  clearIntakeKeyDefaults,
} from '@/lib/ops/interface'
import { parse } from '@/components/forms'

export async function issueKeyAction(formData: FormData): Promise<void> {
  await act('/settings/keys', async (p) => {
    const r = await issueIntegrationKey(p, {
      label: parse.str(formData, 'label'),
      testMode: parse.str(formData, 'test_mode') === 'on',
    })
    return `Key ${r.keyDisplay} issued. COPY THE SECRET NOW — it is shown once and never again: ${r.secret}`
  })
}

export async function revokeKeyAction(formData: FormData): Promise<void> {
  await act('/settings/keys', async (p) => {
    await revokeIntegrationKey(p, { key: parse.num(formData, 'key') })
    return 'Key revoked — the very next request with it is refused.'
  })
}

export async function exportKeyActivityAction(formData: FormData): Promise<void> {
  const key = parse.num(formData, 'key')
  await act(`/settings/keys/${key}`, async (p) => {
    const r = await exportKeyActivity(p, { key })
    return `Activity exported — ${r.rows} row(s), stored artefact #${r.artefact}; the export is recorded.`
  })
}

export async function setKeyDefaultsAction(formData: FormData): Promise<void> {
  const key = parse.num(formData, 'key')
  await act(`/settings/keys/${key}`, async (p) => {
    await setIntakeKeyDefaults(p, {
      key,
      office: parse.num(formData, 'office'),
      responsibleLawyer: parse.num(formData, 'responsible_lawyer'),
      practiceArea: parse.num(formData, 'practice_area'),
    })
    return 'Creation defaults saved — the matter door opens under this office, lawyer and area.'
  })
}

export async function clearKeyDefaultsAction(formData: FormData): Promise<void> {
  const key = parse.num(formData, 'key')
  await act(`/settings/keys/${key}`, async (p) => {
    await clearIntakeKeyDefaults(p, { key })
    return 'Creation defaults cleared — the matter door for this key is closed until new defaults are set.'
  })
}
