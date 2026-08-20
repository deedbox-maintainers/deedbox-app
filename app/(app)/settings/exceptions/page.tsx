// Exceptions routing view: a read-only rendering of the active
// exception-workflow declaration, so accounts staff can see who gets what,
// when. Neutral default: refusals rest visible on the money screens.

import { requirePrincipal } from '@/lib/auth'
import { exceptionsRouting } from '@/lib/reads/config'
import { Page, Panel, EmptyState } from '@/components/ui'

export default async function ExceptionsPage() {
  const p = await requirePrincipal()
  const declaration = await exceptionsRouting(p)
  return (
    <Page
      title="Exceptions routing"
      lead="How refused operations and incidents are routed to people. The routing can only ever create tasks and messages — its grammar has no words for touching money."
    >
      <Panel>
        {declaration === null ? (
          <EmptyState>
            The active pack declares no exception workflow — refusals rest visible on the money
            screens for those who can see firm money, and nothing is routed automatically.
          </EmptyState>
        ) : (
          <pre className="overflow-x-auto rounded bg-neutral-50 p-3 text-xs text-neutral-700">
            {JSON.stringify(declaration, null, 2)}
          </pre>
        )}
      </Panel>
    </Page>
  )
}
