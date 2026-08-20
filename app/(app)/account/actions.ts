'use server'

import { act } from '@/lib/screens/action'
import { endSession, revokeDevice } from '@/lib/ops/security'
import { parse } from '@/components/forms'

export async function endOwnSession(formData: FormData): Promise<void> {
  await act('/account', async (p) => {
    await endSession(p, { session: parse.num(formData, 'session') })
    return 'Session ended.'
  })
}

export async function revokeOwnDevice(formData: FormData): Promise<void> {
  await act('/account', async (p) => {
    await revokeDevice(p, { device: parse.num(formData, 'device') })
    return 'Device revoked; its sessions are ended.'
  })
}

// --- Microsoft 365 connection ---

export async function disconnectM365Action(): Promise<void> {
  await act('/account', async (p) => {
    const { disconnectM365Account } = await import('@/lib/ops/m365')
    await disconnectM365Account(p)
    return 'Microsoft 365 disconnected — the mail poll stops for your account.'
  })
}
