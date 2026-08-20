// The platform scheduler's doorway: POST with the shared secret runs one
// registered job as the system_job principal. The route is deliberately
// thin — parse, authenticate, run, report — with every rule living in the
// operations the registry wraps.

import { NextResponse } from 'next/server'
import { runJob } from '@/lib/jobs/registry'
import { OperationRefused, MoneyRefusal } from '@/lib/db'

export async function POST(
  request: Request,
  context: { params: Promise<{ job: string }> },
): Promise<NextResponse> {
  const secret = process.env.DEEDBOX_JOB_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'jobs_disabled', detail: 'DEEDBOX_JOB_SECRET is not configured' },
      { status: 503 },
    )
  }
  if (request.headers.get('x-job-secret') !== secret) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }
  const { job } = await context.params
  try {
    const outcome = await runJob(job)
    return NextResponse.json({ job, outcome })
  } catch (err) {
    if (err instanceof OperationRefused) {
      const status = err.code === 'unknown_job' ? 404 : 422
      return NextResponse.json({ error: err.code, detail: err.message }, { status })
    }
    if (err instanceof MoneyRefusal) {
      return NextResponse.json(
        { error: 'money_refusal', reason: err.reason, refusal: err.refusalId },
        { status: 422 },
      )
    }
    throw err
  }
}
