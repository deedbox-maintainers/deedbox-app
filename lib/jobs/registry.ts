// The platform-scheduled jobs: every runner is an ALREADY-PROVEN operation
// invoked as the system_job principal through the same plumbing as
// everything else — registered, guarded, testable. The scheduler calls the
// route in app/api/jobs/[job]; this registry is the single catalogue of
// what a job key runs.
//
// Job identity: the register's actor column is a plain number, and the
// schema ships no job-registry table — each job carries a stable small id
// here (the convention the suites already use). The outbound dispatch job
// additionally needs a delivery transport, bound at deployment via
// setOutboundTransport; until bound it refuses with a typed message rather
// than pretending to send.

import type { Principal } from '@/lib/db'
import { OperationRefused } from '@/lib/db'
import { seamSlot } from '@/lib/seam-slot'
import { theFirm } from '@/lib/db'
import { runThresholdSweep } from '@/lib/ops/billing/thresholds'
import { runReminderScheduler } from '@/lib/ops/billing/reminders'
import {
  runInstalmentNotifications,
  runInstalmentCollections,
  runMissedInstalmentDetection,
} from '@/lib/ops/billing/arrangements'
import { generateInterestProposals } from '@/lib/ops/billing/interest'
import { routeUnallocatedRemainders } from '@/lib/ops/billing/remainder'
import { runStaleInstrumentSweep } from '@/lib/ops/money/instruments'
import { runDormancyDetection } from '@/lib/ops/money/dormancy'
import { materialiseCloseObligations } from '@/lib/ops/money/close'
import { runDueSchedules } from '@/lib/ops/reports/schedules'
import {
  recomputePositionCache,
  verifyPositionCache,
  rebuildSearchIndex,
} from '@/lib/ops/reports/experience'
import { dispatchOutboundQueue, type Deliverer } from '@/lib/ops/outbound'
import { runSessionTimeouts } from '@/lib/ops/security/sessions'
import { runExaminerExpiry } from '@/lib/ops/security/examiners'
import { runAnomalyEvaluation, runChainVerification } from '@/lib/ops/security/anomalyJobs'
import { runSetAsideRecalculation } from '@/lib/ops/money/setAside'
import { runDocumentTextSweep } from '@/lib/ops/documents/textSweep'
import { runMailPoll } from '@/lib/ops/m365/email'
import { runFilingMailboxPoll } from '@/lib/ops/m365/filing'
import { runGlSync } from '@/lib/ops/gl/sync'

// Process-wide, not module-level: see lib/seam-slot.ts for why.
const outboundTransport = seamSlot<Deliverer>('outbound-transport')

/** Bound once at deployment by the delivery integration. */
export function setOutboundTransport(deliver: Deliverer | null): void {
  outboundTransport.set(deliver)
}

interface JobDefinition {
  id: number
  run: (p: Principal) => Promise<unknown>
}

const JOBS: Record<string, JobDefinition> = {
  'threshold-sweep': { id: 1, run: (p) => runThresholdSweep(p) },
  'reminder-scheduler': { id: 2, run: (p) => runReminderScheduler(p) },
  'instalment-notifications': { id: 3, run: (p) => runInstalmentNotifications(p) },
  'instalment-collections': { id: 4, run: (p) => runInstalmentCollections(p) },
  'missed-instalment-detection': { id: 5, run: (p) => runMissedInstalmentDetection(p) },
  'interest-proposals': { id: 6, run: (p) => generateInterestProposals(p) },
  'remainder-routing': { id: 7, run: (p) => routeUnallocatedRemainders(p) },
  'stale-instruments': { id: 8, run: (p) => runStaleInstrumentSweep(p) },
  'dormancy-detection': { id: 9, run: (p) => runDormancyDetection(p) },
  'close-materialiser': { id: 10, run: (p) => materialiseCloseObligations(p) },
  'schedule-sends': { id: 11, run: (p) => runDueSchedules(p) },
  'cache-recompute': { id: 12, run: (p) => recomputePositionCache(p) },
  'cache-verify': { id: 13, run: (p) => verifyPositionCache(p) },
  'index-rebuild': { id: 14, run: (p) => rebuildSearchIndex(p) },
  'session-timeouts': { id: 16, run: (p) => runSessionTimeouts(p) },
  'examiner-expiry': { id: 17, run: (p) => runExaminerExpiry(p) },
  'anomaly-evaluation': { id: 18, run: (p) => runAnomalyEvaluation(p) },
  'chain-verifier': { id: 19, run: (p) => runChainVerification(p) },
  'set-aside-recalculation': { id: 20, run: (p) => runSetAsideRecalculation(p) },
  'document-text-extraction': { id: 21, run: (p) => runDocumentTextSweep(p) },
  'm365-mail-poll': { id: 22, run: (p) => runMailPoll(p) },
  'gl-sync': { id: 23, run: (p) => runGlSync(p) },
  'm365-filing-poll': { id: 24, run: (p) => runFilingMailboxPoll(p) },
  'outbound-dispatch': {
    id: 15,
    run: (p) => {
      const transport = outboundTransport.get()
      if (transport === null) {
        throw new OperationRefused(
          'transport_unbound',
          'no delivery transport is bound — the deployment binds it',
        )
      }
      return dispatchOutboundQueue(p, transport)
    },
  },
}

export function listJobs(): string[] {
  return Object.keys(JOBS)
}

/** Run one job as its system principal. Unknown keys refuse. */
export async function runJob(key: string, firmId?: number): Promise<unknown> {
  const def = JOBS[key]
  if (!def) throw new OperationRefused('unknown_job', `no job named ${key}`)
  const firm = firmId ?? (await theFirm())
  const principal: Principal = { kind: 'system_job', id: def.id, firm }
  return def.run(principal)
}
