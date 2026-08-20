// Server-start hook: bind the deployment's real services onto the core's
// seams (outbound transport, sign-in service, intake document store) from
// the environment. Runs once per server process; anything unconfigured
// stays loudly unbound. The test suites never load this file — they bind
// and unbind seams explicitly.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return
  const { bindFromEnvironment } = await import('@/lib/bindings')
  bindFromEnvironment()
}
