// The deployment seams must be PROCESS-wide, not module-wide.
//
// The framework compiles the boot hook, the server components/actions and
// the client-component rendering as separate bundles, and each bundle
// evaluates the seam modules afresh. A binding kept in a module-level
// variable is therefore made in one instance and read from another — which
// is exactly what the first real deployment showed: boot
// logged "sign-in service: bound (hosted)", the sign-in action refused
// "no sign-in service is bound". This suite reproduces that split with
// vi.resetModules() — bind through one module instance, then read through a
// genuinely fresh one — and DISCRIMINATES: on the old module-level `let`
// every assertion below fails; on the process-wide slot they pass.
//
// Cross-suite contract: pure (no database rows touched); every seam it
// binds is unbound again in afterEach so later suites find the seams clear.

import { describe, it, expect, vi, afterEach } from 'vitest'

async function unbindEverything() {
  vi.resetModules()
  const seam = await import('@/lib/auth/seam')
  seam.setSignInService(null)
  const assistant = await import('@/lib/ops/assistant/seam')
  assistant.setAssistantModelService(null)
  const store = await import('@/lib/ops/documents/store')
  store.setDocumentByteStore(null)
  store.setDocumentByteFetch(null)
  const m365 = await import('@/lib/ops/m365/seam')
  m365.setM365Service(null)
  const registry = await import('@/lib/jobs/registry')
  registry.setOutboundTransport(null)
  const intake = await import('@/lib/ops/interface/intakeApi')
  intake.setIntakeDocumentStore(null)
}

describe('deployment seams are process-wide', () => {
  afterEach(unbindEverything)

  it('the slot itself survives a fresh module instance', async () => {
    const a = await import('@/lib/seam-slot')
    const token = { marker: 'bound-through-instance-a' }
    a.seamSlot<typeof token>('test-only-slot').set(token)
    vi.resetModules()
    const b = await import('@/lib/seam-slot')
    expect(b).not.toBe(a) // genuinely a different module instance
    expect(b.seamSlot<typeof token>('test-only-slot').get()).toBe(token)
    b.seamSlot<typeof token>('test-only-slot').set(null)
  })

  it('a sign-in service bound through one instance is what a fresh instance resolves', async () => {
    const first = await import('@/lib/auth/seam')
    const svc = {
      authenticate: async () => ({ authenticated: true, mfaSatisfied: true }),
      verifyStepUpChallenge: async () => true,
    }
    first.setSignInService(svc)
    vi.resetModules()
    const second = await import('@/lib/auth/seam')
    expect(second).not.toBe(first)
    expect(second.signInService()).toBe(svc)
  })

  it('an unbound sign-in seam still refuses typed from a fresh instance', async () => {
    const first = await import('@/lib/auth/seam')
    first.setSignInService(null)
    vi.resetModules()
    const second = await import('@/lib/auth/seam')
    const { OperationRefused } = await import('@/lib/db')
    expect(() => second.signInService()).toThrow(OperationRefused)
  })

  it('the assistant model, byte store, byte fetch and Microsoft 365 seams behave the same way', async () => {
    const assistant = await import('@/lib/ops/assistant/seam')
    const model = { model: 'test-model', answer: async () => 'answer' }
    assistant.setAssistantModelService(model)

    const store = await import('@/lib/ops/documents/store')
    const byteStore = async () => ({ storageRef: 'ref', contentType: 'text/plain' })
    const byteFetch = async () => ({ bytes: Buffer.from('x'), contentType: 'text/plain' })
    store.setDocumentByteStore(byteStore)
    store.setDocumentByteFetch(byteFetch)

    const m365 = await import('@/lib/ops/m365/seam')
    const graph = { marker: 'm365' } as unknown as Parameters<typeof m365.setM365Service>[0]
    m365.setM365Service(graph)

    vi.resetModules()

    const assistant2 = await import('@/lib/ops/assistant/seam')
    expect(assistant2).not.toBe(assistant)
    expect(assistant2.assistantModelService()).toBe(model)
    const store2 = await import('@/lib/ops/documents/store')
    expect(store2.requireByteStore()).toBe(byteStore)
    expect(store2.requireByteFetch()).toBe(byteFetch)
    const m3652 = await import('@/lib/ops/m365/seam')
    expect(m3652.m365Service()).toBe(graph)
  })
})
