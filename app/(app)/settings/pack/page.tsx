// Pack console: active pack and version, per-version declaration
// browser (read-only), activation with validation, activation history.

import { requirePrincipal } from '@/lib/auth'
import { packConsole } from '@/lib/reads/config'
import { Page, Panel, Badge, EmptyState, Notices, fmtDateTime } from '@/components/ui'
import { InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { activatePack } from '../actions'

export default async function PackPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const c = await packConsole(p)
  if (!c) {
    return (
      <Page title="Country pack">
        <EmptyState>No country pack is installed on this instance.</EmptyState>
      </Page>
    )
  }
  const declaredPoints = new Set(
    c.declarations.filter((d) => d.pack_version === c.pack.active_version).map((d) => d.rule_point),
  )
  return (
    <Page
      title="Country pack"
      lead={`${c.pack.name} (${c.pack.code}). A pack version governs only after activation; a version with any invalid declaration is refused whole.`}
    >
      <Notices searchParams={sp} />
      <Panel title="Versions">
        <div className="divide-y divide-neutral-100">
          {c.versions.map((v) => (
            <div key={v.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div>
                <span className="font-medium text-neutral-800">{v.version}</span>{' '}
                <span className="text-neutral-400">released {fmtDateTime(v.released_at)}</span>{' '}
                {v.id === c.pack.active_version ? <Badge tone="green">active</Badge> : null}
              </div>
              {v.id !== c.pack.active_version ? (
                <InlineAction action={activatePack} fields={{ version: v.id }} label="Activate" />
              ) : null}
            </div>
          ))}
          {c.versions.length === 0 ? (
            <EmptyState>No versions installed — the release pipeline installs them.</EmptyState>
          ) : null}
        </div>
      </Panel>
      <Panel title="Rule points (active version)">
        <div className="divide-y divide-neutral-100">
          {c.rulePoints.map((rp) => {
            const decl = c.declarations.find(
              (d) => d.pack_version === c.pack.active_version && d.rule_point === rp.key,
            )
            return (
              <details key={rp.key} className="py-1.5 text-sm">
                <summary className="cursor-pointer">
                  <span className="font-medium text-neutral-800">{rp.key}</span>{' '}
                  {declaredPoints.has(rp.key) ? (
                    <Badge tone="blue">declared</Badge>
                  ) : (
                    <Badge tone="neutral">neutral</Badge>
                  )}
                </summary>
                <p className="mt-1 text-neutral-500">{rp.description}</p>
                {decl ? (
                  <pre className="mt-1 overflow-x-auto rounded bg-neutral-50 p-2 text-xs text-neutral-600">
                    {JSON.stringify(decl.body, null, 2)}
                  </pre>
                ) : (
                  <p className="mt-1 text-xs text-neutral-400">
                    This pack adds no rule at this point — the engine&apos;s neutral behaviour applies.
                  </p>
                )}
              </details>
            )
          })}
        </div>
      </Panel>
      <Panel title="Activation history">
        {c.activations.length === 0 ? (
          <EmptyState>No activations recorded.</EmptyState>
        ) : (
          <ul className="space-y-1 text-sm text-neutral-600">
            {c.activations.map((a, i) => (
              <li key={i}>
                {fmtDateTime(a.occurred_at)} — <code className="text-xs">{JSON.stringify(a.detail)}</code>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Page>
  )
}
