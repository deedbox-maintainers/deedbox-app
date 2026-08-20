// One process-wide slot per deployment seam.
//
// The seams (sign-in service, outbound transport, document store, byte
// store/fetch, Microsoft 365, assistant model) are bound ONCE at server
// start by lib/bindings and read by the operations that need them. They
// used to hold the bound service in a module-level `let`. That is not
// shared across the framework's server layers — the boot hook, the server
// components/actions and the client-component rendering are compiled as
// separate bundles, each carrying its OWN instance of the module — so a
// binding made at boot was invisible to the code that needed it. First seen
// on the first real deployment: the boot log printed "sign-in
// service: bound (hosted)" and the sign-in action refused "no sign-in
// service is bound". globalThis is per process and shared by every layer.
//
// Test suites bind and unbind through the same setters as before; within one
// test process the semantics are unchanged.

const ROOT = Symbol.for('deedbox.seams')

type SeamTable = Record<string, unknown>

function table(): SeamTable {
  const g = globalThis as unknown as { [ROOT]?: SeamTable }
  if (!g[ROOT]) g[ROOT] = {}
  return g[ROOT]
}

export interface SeamSlot<T> {
  get(): T | null
  set(value: T | null): void
}

/** A named slot; the same name from any module instance is the same slot. */
export function seamSlot<T>(name: string): SeamSlot<T> {
  return {
    get: () => (table()[name] as T | undefined) ?? null,
    set: (value) => {
      table()[name] = value
    },
  }
}
