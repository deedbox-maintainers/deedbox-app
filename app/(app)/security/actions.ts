'use server'

// Security-area server actions: parse → named operation → notice. Thin by
// design; every rule lives in lib/ops/security.

import { act } from '@/lib/screens/action'
import {
  endSession,
  endAllSessionsFor,
  createStaffMember,
  changeStaffRole,
  deactivateStaff,
  reactivateStaff,
  createRole,
  renameRole,
  setRoleActive,
  setRoleCapability,
  saveAuthPolicy,
  acknowledgeAnomaly,
  restoreSoftDeleted,
  grantExaminer,
  revokeExaminer,
} from '@/lib/ops/security'
import { parse } from '@/components/forms'

export async function endAnySession(formData: FormData): Promise<void> {
  await act('/security/sessions', async (p) => {
    await endSession(p, { session: parse.num(formData, 'session') })
    return 'Session ended.'
  })
}

export async function endAllFor(formData: FormData): Promise<void> {
  await act('/security/sessions', async (p) => {
    const r = await endAllSessionsFor(p, { staff: parse.num(formData, 'staff') })
    return `${r.ended} session(s) ended.`
  })
}

export async function addStaff(formData: FormData): Promise<void> {
  await act('/security/staff', async (p) => {
    const given = parse.str(formData, 'given')
    const family = parse.str(formData, 'family')
    const r = await createStaffMember(p, {
      personName: { given: given || undefined, family: family || undefined },
      login: parse.str(formData, 'login'),
      role: parse.num(formData, 'role'),
      office: parse.num(formData, 'office'),
      email: parse.str(formData, 'email'),
    })
    return `goto:/security/staff/${r.id}?done=${encodeURIComponent('Staff member created.')}`
  })
}

export async function changeRole(formData: FormData): Promise<void> {
  const staff = parse.num(formData, 'staff')
  await act(`/security/staff/${staff}`, async (p) => {
    await changeStaffRole(p, { staff, role: parse.num(formData, 'role') })
    return 'Role changed — it takes effect immediately.'
  })
}

export async function deactivate(formData: FormData): Promise<void> {
  const staff = parse.num(formData, 'staff')
  await act(`/security/staff/${staff}`, async (p) => {
    await deactivateStaff(p, { staff })
    return 'Deactivated; their sessions are ended.'
  })
}

export async function reactivate(formData: FormData): Promise<void> {
  const staff = parse.num(formData, 'staff')
  await act(`/security/staff/${staff}`, async (p) => {
    await reactivateStaff(p, { staff })
    return 'Reactivated.'
  })
}

export async function addRole(formData: FormData): Promise<void> {
  await act('/security/roles', async (p) => {
    await createRole(p, { name: parse.str(formData, 'name'), external: parse.bool(formData, 'external') })
    return 'Role created.'
  })
}

export async function renameRoleAction(formData: FormData): Promise<void> {
  await act('/security/roles', async (p) => {
    await renameRole(p, { role: parse.num(formData, 'role'), name: parse.str(formData, 'name') })
    return 'Role renamed.'
  })
}

export async function setRoleActiveAction(formData: FormData): Promise<void> {
  await act('/security/roles', async (p) => {
    await setRoleActive(p, {
      role: parse.num(formData, 'role'),
      active: parse.bool(formData, 'active'),
    })
    return 'Role updated.'
  })
}

export async function setCapability(formData: FormData): Promise<void> {
  await act('/security/roles', async (p) => {
    const capability = parse.str(formData, 'capability')
    const scope = parse.str(formData, 'scope') as 'firm_wide' | 'own_figures_only' | 'none'
    await setRoleCapability(p, {
      role: parse.num(formData, 'role'),
      capability,
      scope,
      confirmMoneyAuthorisation: parse.bool(formData, 'confirm_money'),
    })
    return scope === 'none' ? `${capability} removed.` : `${capability} granted (${scope}).`
  })
}

export async function savePolicy(formData: FormData): Promise<void> {
  await act('/security/policy', async (p) => {
    const scope = parse.str(formData, 'mfa_scope') as 'off' | 'named_roles' | 'all_users'
    const roles = formData
      .getAll('mfa_roles')
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n))
    await saveAuthPolicy(p, {
      mfaScope: scope,
      mfaRoles: scope === 'named_roles' ? roles : undefined,
      stepUpOnUnrecognised: parse.bool(formData, 'step_up_on_unrecognised'),
      stepUpEmailFallback: parse.bool(formData, 'step_up_email_fallback'),
    })
    return 'Policy saved.'
  })
}

export async function acknowledge(formData: FormData): Promise<void> {
  await act('/security/anomalies', async (p) => {
    await acknowledgeAnomaly(p, { alert: parse.num(formData, 'alert') })
    return 'Acknowledged.'
  })
}

export async function restoreRecord(formData: FormData): Promise<void> {
  await act('/security/restore', async (p) => {
    await restoreSoftDeleted(p, {
      entityType: parse.str(formData, 'entity_type'),
      id: parse.num(formData, 'id'),
    })
    return 'Restored.'
  })
}

export async function grantExaminerAction(formData: FormData): Promise<void> {
  await act('/security/examiners', async (p) => {
    const r = await grantExaminer(p, {
      examinerName: parse.str(formData, 'examiner_name'),
      login: parse.str(formData, 'login'),
      periodStart: parse.str(formData, 'period_start'),
      periodEnd: parse.str(formData, 'period_end'),
      startsAt: new Date(parse.str(formData, 'starts_at')).toISOString(),
      expiresAt: new Date(parse.str(formData, 'expires_at')).toISOString(),
    })
    // the one showing of the secret rides the notice — it is never stored in clear
    return `Grant #${r.id} created. One-time sign-in secret (copy it NOW — it is never shown again): ${r.secret}`
  })
}

export async function revokeExaminerAction(formData: FormData): Promise<void> {
  await act('/security/examiners', async (p) => {
    const r = await revokeExaminer(p, {
      grant: parse.num(formData, 'grant'),
      reason: parse.str(formData, 'reason'),
    })
    return `Revoked; ${r.endedSessions} session(s) ended.`
  })
}
