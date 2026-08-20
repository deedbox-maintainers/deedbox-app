'use server'

// The examination workspace's one action: the one-action examination pack
// export on the examiner path. Everything else here is read-only by design.

import { act } from '@/lib/screens/action'
import { exportExaminationPack } from '@/lib/ops/security'
import { parse } from '@/components/forms'

export async function exportPackAction(formData: FormData): Promise<void> {
  await act('/examiner', async (p) => {
    const r = await exportExaminationPack(p, {
      periodStart: parse.str(formData, 'period_start'),
      periodEnd: parse.str(formData, 'period_end'),
    })
    return `Examination pack exported — ${r.transactions} movement(s); stored artefact #${r.artefact}. The export is recorded.`
  })
}
