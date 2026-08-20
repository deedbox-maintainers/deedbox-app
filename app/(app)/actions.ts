'use server'

// Home-shell actions: pins and the view trail. recordView is wired into
// the matter and party profiles; these cover pin/unpin from any surface
// that posts here.

import { act } from '@/lib/screens/action'
import { pinItem, unpinItem } from '@/lib/ops/reports'
import { parse } from '@/components/forms'

export async function pinAction(formData: FormData): Promise<void> {
  const back = parse.str(formData, 'back') || '/'
  await act(back, async (p) => {
    await pinItem(p, {
      itemType: parse.str(formData, 'item_type') as 'matter' | 'party',
      item: parse.num(formData, 'item'),
    })
    return 'Pinned.'
  })
}

export async function unpinAction(formData: FormData): Promise<void> {
  const back = parse.str(formData, 'back') || '/'
  await act(back, async (p) => {
    await unpinItem(p, {
      itemType: parse.str(formData, 'item_type') as 'matter' | 'party',
      item: parse.num(formData, 'item'),
    })
    return 'Unpinned.'
  })
}
