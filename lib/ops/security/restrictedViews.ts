// Restricted-read recording for screen surfaces.
//
// When a surface renders restricted-matter content to a cleared user, the
// disclosure is registered: check the per-(session, matter, surface) marker;
// if absent, insert it and append `restricted.read` — in its OWN committed
// transaction, BEFORE the response is returned. If the recording fails the
// content is withheld (fail closed): the caller lets the thrown error
// propagate instead of rendering.
//
// Batch surfaces (lists) record all their matters in one transaction, one
// entry per matter. Without a terminal session (jobs, tests) the marker
// dedup cannot apply and the entry is written every time — the same honest
// posture runConflictCheck takes for its pinhole disclosures.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister } from '@/lib/db'

/**
 * Record the viewing of restricted matters on a named surface. Call with the
 * restricted matter ids a screen is ABOUT to render; returns after the
 * entries are committed. No-op for an empty list.
 */
export async function recordRestrictedViews(
  p: Principal,
  matterIds: number[],
  surface: string,
): Promise<void> {
  const unique = [...new Set(matterIds)]
  if (unique.length === 0) return
  await withPrincipal(p, async (tx) => {
    for (const matter of unique) {
      if (p.session !== undefined) {
        const seen = await tx.query(
          `select 1 from deedbox.restricted_read_marker
            where session_ref = $1 and matter = $2 and surface = $3`,
          [p.session, matter, surface],
        )
        if (seen.rowCount! > 0) continue
        await tx.query(
          `insert into deedbox.restricted_read_marker (session_ref, matter, surface)
           values ($1, $2, $3)`,
          [p.session, matter, surface],
        )
      }
      await emitRegister(tx, p, {
        kind: 'restricted.read',
        subjectType: 'matter',
        subject: matter,
        matter,
        detail: { surface },
      })
    }
  })
}
