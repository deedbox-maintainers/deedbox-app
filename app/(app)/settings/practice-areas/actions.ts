'use server'

// Practice-area administration actions.

import { act } from '@/lib/screens/action'
import {
  createPracticeArea,
  renamePracticeArea,
  setPracticeAreaActive,
  setConflictRequirement,
  setRelatablePair,
} from '@/lib/ops/matters'
import { parse } from '@/components/forms'

const HOME = '/settings/practice-areas'

export async function addAreaAction(formData: FormData): Promise<void> {
  await act(HOME, async (p) => {
    await createPracticeArea(p, {
      name: parse.str(formData, 'name'),
      requireConflictResolution: parse.bool(formData, 'require_conflict'),
    })
    return 'Practice area created.'
  })
}

export async function renameAreaAction(formData: FormData): Promise<void> {
  await act(HOME, async (p) => {
    await renamePracticeArea(p, {
      area: parse.num(formData, 'area'),
      name: parse.str(formData, 'name'),
    })
    return 'Renamed.'
  })
}

export async function setAreaActiveAction(formData: FormData): Promise<void> {
  await act(HOME, async (p) => {
    const active = parse.bool(formData, 'active')
    await setPracticeAreaActive(p, { area: parse.num(formData, 'area'), active })
    return active ? 'Reactivated.' : 'Deactivated — existing matters keep it; new ones cannot pick it.'
  })
}

export async function setConflictFlagAction(formData: FormData): Promise<void> {
  await act(HOME, async (p) => {
    const on = parse.bool(formData, 'require')
    await setConflictRequirement(p, { area: parse.num(formData, 'area'), required: on })
    return on
      ? 'This area now demands a resolved conflict check before a matter opens.'
      : 'Conflict-check requirement removed for this area.'
  })
}

export async function setPairAction(formData: FormData): Promise<void> {
  await act(HOME, async (p) => {
    const allowed = parse.str(formData, 'allowed') === 'true'
    await setRelatablePair(p, {
      areaA: parse.num(formData, 'area_a'),
      areaB: parse.num(formData, 'area_b'),
      allowed,
    })
    return `Pair rule recorded: relations ${allowed ? 'allowed' : 'forbidden'}.`
  })
}
