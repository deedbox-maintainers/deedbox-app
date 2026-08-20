'use server'

// Configuration-area server actions: parse → named operation → notice.

import { act } from '@/lib/screens/action'
import { OperationRefused } from '@/lib/db'
import {
  changeSetting,
  revertSetting,
  cancelScheduledSetting,
  activatePackVersion,
  replaceNumberFormat,
  createChoiceList,
  addChoiceItem,
  relabelChoiceItem,
  setChoiceItemChargeability,
  deactivateChoiceItem,
  reactivateChoiceItem,
  deleteUnusedChoiceItem,
  defineCustomField,
  editCustomField,
  setCustomFieldActive,
  defineFieldSet,
  createMessageTemplate,
  editMessageTemplate,
  deactivateMessageTemplate,
  registerNamespace,
  rotatePrincipalSecret,
  suspendNamespace,
  reinstateNamespace,
  retireNamespace,
  setConfigSlot,
  setBranding,
  resetBranding,
  keepDefaultBranding,
} from '@/lib/ops/config'
import { parse } from '@/components/forms'
import { PRODUCT_NAME } from '@/lib/brand'

/** Parse the typed form value per the definition's value type. */
function typedValue(valueType: string, raw: string): unknown {
  switch (valueType) {
    case 'boolean':
      return raw === 'true' || raw === 'on'
    case 'integer':
    case 'duration_days':
      return Number(raw)
    case 'money':
    case 'percentage':
    case 'decimal':
      return raw === '' ? null : Number(raw)
    case 'doc':
      return JSON.parse(raw)
    case 'choice':
      if (raw === '') return null
      return /^\d+$/.test(raw) ? Number(raw) : raw
    default:
      return raw
  }
}

export async function changeSettingAction(formData: FormData): Promise<void> {
  const key = parse.str(formData, 'key')
  await act('/settings', async (p) => {
    const raw = parse.str(formData, 'value')
    let value: unknown
    try {
      value = typedValue(parse.str(formData, 'value_type'), raw)
    } catch {
      return `goto:/settings?refused=${encodeURIComponent(`${key}: that value is not valid JSON`)}`
    }
    const effectiveFrom = parse.strOrNull(formData, 'effective_from')
    await changeSetting(p, {
      key,
      value,
      effectiveFrom: effectiveFrom ? new Date(effectiveFrom).toISOString() : undefined,
      staffLogin: parse.strOrNull(formData, 'staff_login') ?? undefined,
    })
    return `${key} changed.`
  })
}

export async function revertSettingAction(formData: FormData): Promise<void> {
  const key = parse.str(formData, 'key')
  await act('/settings', async (p) => {
    await revertSetting(p, { key })
    return `${key} reverted to its neutral default.`
  })
}

export async function cancelScheduledAction(formData: FormData): Promise<void> {
  const key = parse.str(formData, 'key')
  await act('/settings', async (p) => {
    await cancelScheduledSetting(p, { key, settingRow: parse.num(formData, 'row') })
    return `The scheduled value for ${key} is cancelled.`
  })
}

export async function activatePack(formData: FormData): Promise<void> {
  await act('/settings/pack', async (p) => {
    const r = await activatePackVersion(p, { version: parse.num(formData, 'version') })
    return `Version activated (pack #${r.pack}).`
  })
}

export async function replaceFormat(formData: FormData): Promise<void> {
  await act('/settings/numbering', async (p) => {
    await replaceNumberFormat(p, {
      purpose: parse.str(formData, 'purpose'),
      scope: parse.strOrNull(formData, 'scope'),
      pattern: parse.str(formData, 'pattern'),
      allocationMode: parse.str(formData, 'allocation_mode') as 'sequence' | 'gapless',
      reset: parse.str(formData, 'reset') as 'never' | 'yearly' | 'daily',
    })
    return 'Format replaced. Existing numbers are untouched and the series continues.'
  })
}

export async function addListAction(formData: FormData): Promise<void> {
  await act('/settings/lists', async (p) => {
    await createChoiceList(p, {
      purposeKey: `custom.${parse.str(formData, 'key')}`,
      name: parse.str(formData, 'name'),
    })
    return 'List created.'
  })
}

export async function addItemAction(formData: FormData): Promise<void> {
  await act('/settings/lists', async (p) => {
    const chargeable = parse.str(formData, 'chargeable')
    await addChoiceItem(p, {
      list: parse.num(formData, 'list'),
      label: parse.str(formData, 'label'),
      countsAsChargeable: chargeable === '' ? undefined : chargeable === 'true',
    })
    return 'Item added.'
  })
}

export async function relabelItemAction(formData: FormData): Promise<void> {
  await act('/settings/lists', async (p) => {
    await relabelChoiceItem(p, { item: parse.num(formData, 'item'), label: parse.str(formData, 'label') })
    return 'Item relabelled.'
  })
}

export async function setChargeabilityAction(formData: FormData): Promise<void> {
  await act('/settings/lists', async (p) => {
    await setChoiceItemChargeability(p, {
      item: parse.num(formData, 'item'),
      countsAsChargeable: parse.bool(formData, 'counts_as_chargeable'),
    })
    return 'Chargeability changed. Recorded entries keep the values they were saved with.'
  })
}

export async function setItemActiveAction(formData: FormData): Promise<void> {
  await act('/settings/lists', async (p) => {
    if (parse.bool(formData, 'active')) {
      await reactivateChoiceItem(p, { item: parse.num(formData, 'item') })
      return 'Item reactivated.'
    }
    await deactivateChoiceItem(p, { item: parse.num(formData, 'item') })
    return 'Item deactivated — history keeps it; pickers lose it.'
  })
}

export async function deleteItemAction(formData: FormData): Promise<void> {
  await act('/settings/lists', async (p) => {
    await deleteUnusedChoiceItem(p, { item: parse.num(formData, 'item') })
    return 'Item deleted.'
  })
}

export async function defineFieldAction(formData: FormData): Promise<void> {
  await act('/settings/fields', async (p) => {
    await defineCustomField(p, {
      scope: parse.str(formData, 'scope') as 'party' | 'matter' | 'intake',
      key: parse.str(formData, 'key'),
      label: parse.str(formData, 'label'),
      dataType: parse.str(formData, 'data_type') as 'text' | 'number' | 'date' | 'choice' | 'party_link',
      required: parse.bool(formData, 'required'),
      searchable: parse.bool(formData, 'searchable'),
      fieldSet: parse.numOrNull(formData, 'field_set') ?? undefined,
    })
    return 'Field defined.'
  })
}

export async function editFieldAction(formData: FormData): Promise<void> {
  await act('/settings/fields', async (p) => {
    await editCustomField(p, {
      definition: parse.num(formData, 'definition'),
      label: parse.strOrNull(formData, 'label') ?? undefined,
      position: parse.numOrNull(formData, 'position') ?? undefined,
      required: parse.bool(formData, 'required'),
      searchable: parse.bool(formData, 'searchable'),
    })
    return 'Field updated.'
  })
}

export async function setFieldActiveAction(formData: FormData): Promise<void> {
  await act('/settings/fields', async (p) => {
    await setCustomFieldActive(p, {
      definition: parse.num(formData, 'definition'),
      active: parse.bool(formData, 'active'),
    })
    return 'Field state changed. Recorded values are kept either way.'
  })
}

export async function defineSetAction(formData: FormData): Promise<void> {
  await act('/settings/fields', async (p) => {
    await defineFieldSet(p, {
      name: parse.str(formData, 'name'),
      scope: parse.str(formData, 'scope') as 'matter' | 'intake',
    })
    return 'Field set created.'
  })
}

export async function createTemplateAction(formData: FormData): Promise<void> {
  await act('/settings/templates', async (p) => {
    await createMessageTemplate(p, {
      name: parse.str(formData, 'name'),
      channel: parse.str(formData, 'channel') as 'email' | 'text_message' | 'task',
      purpose: parse.str(formData, 'purpose'),
      subject: parse.strOrNull(formData, 'subject') ?? undefined,
      body: parse.str(formData, 'body'),
    })
    return 'Template created.'
  })
}

export async function editTemplateAction(formData: FormData): Promise<void> {
  await act('/settings/templates', async (p) => {
    await editMessageTemplate(p, {
      template: parse.num(formData, 'template'),
      name: parse.strOrNull(formData, 'name') ?? undefined,
      subject: parse.strOrNull(formData, 'subject'),
      body: parse.strOrNull(formData, 'body') ?? undefined,
    })
    return 'Template updated.'
  })
}

export async function deactivateTemplateAction(formData: FormData): Promise<void> {
  await act('/settings/templates', async (p) => {
    await deactivateMessageTemplate(p, { template: parse.num(formData, 'template') })
    return 'Template deactivated. Reminder steps pointing at it demote to their defaults loudly.'
  })
}

// --- the private layer --------------------------------------------------------

export async function registerNamespaceAction(formData: FormData): Promise<void> {
  await act('/settings/private-layer', async (p) => {
    const mountsRaw = parse.strOrNull(formData, 'declared_mounts')
    let declaredMounts: { point: string; title?: string }[] | undefined
    if (mountsRaw) {
      try {
        declaredMounts = JSON.parse(mountsRaw)
      } catch {
        throw new OperationRefused('mounts_shape', 'declared mounts must be a JSON list of {point, title}')
      }
    }
    const r = await registerNamespace(p, {
      namespace: parse.str(formData, 'namespace'),
      description: parse.str(formData, 'description'),
      declaredMounts,
    })
    return `Namespace registered. COPY THE PRINCIPAL SECRET NOW — it is shown once and never again: ${r.secret}`
  })
}

export async function rotateNamespaceSecretAction(formData: FormData): Promise<void> {
  await act('/settings/private-layer', async (p) => {
    const r = await rotatePrincipalSecret(p, { namespace: parse.str(formData, 'namespace') })
    return `Secret rotated. COPY IT NOW — shown once and never again: ${r.secret}`
  })
}

export async function suspendNamespaceAction(formData: FormData): Promise<void> {
  await act('/settings/private-layer', async (p) => {
    await suspendNamespace(p, {
      namespace: parse.str(formData, 'namespace'),
      reason: parse.str(formData, 'reason'),
    })
    return 'Namespace suspended — its view grants are revoked and its mounts are dark, effective immediately.'
  })
}

export async function reinstateNamespaceAction(formData: FormData): Promise<void> {
  await act('/settings/private-layer', async (p) => {
    await reinstateNamespace(p, { namespace: parse.str(formData, 'namespace') })
    return 'Namespace reinstated — view grants restored.'
  })
}

export async function retireNamespaceAction(formData: FormData): Promise<void> {
  await act('/settings/private-layer', async (p) => {
    await retireNamespace(p, { namespace: parse.str(formData, 'namespace') })
    return 'Namespace retired — terminal; views revoked and the principal frozen.'
  })
}

export async function setConfigSlotAction(formData: FormData): Promise<void> {
  await act('/settings/private-layer', async (p) => {
    const raw = parse.str(formData, 'value')
    let value: Record<string, unknown>
    try {
      value = JSON.parse(raw)
    } catch {
      throw new OperationRefused('value_shape', 'the slot value must be a JSON document of named fields')
    }
    await setConfigSlot(p, {
      slot: parse.str(formData, 'slot') as 'branding' | 'bank_details' | 'timezone_display' | 'custom_entry',
      entryKey: parse.str(formData, 'entry_key'),
      value,
    })
    return 'Slot saved and registered.'
  })
}

// ---------------------------------------------------------------------------
// Branding (white-label): the installation's name, logo, icon and colours.
// ---------------------------------------------------------------------------

async function optionalFile(formData: FormData, key: string): Promise<{ filename: string; bytes: Buffer } | undefined> {
  const f = formData.get(key)
  if (!(f instanceof File) || f.size === 0) return undefined
  return { filename: f.name, bytes: Buffer.from(await f.arrayBuffer()) }
}

export async function setBrandingAction(formData: FormData): Promise<void> {
  await act('/settings', async (p) => {
    const logo = await optionalFile(formData, 'logo')
    const icon = await optionalFile(formData, 'icon')
    await setBranding(p, {
      displayName: parse.str(formData, 'display_name'),
      colourPrimary: parse.str(formData, 'colour_primary'),
      colourSecondary: parse.str(formData, 'colour_secondary'),
      logo,
      icon,
    })
    return 'Branding saved — the new look shows on every page from the next load.'
  })
}

export async function resetBrandingAction(): Promise<void> {
  await act('/settings', async (p) => {
    await resetBranding(p)
    return `Branding reset to the ${PRODUCT_NAME} default.`
  })
}

export async function keepDefaultBrandingAction(): Promise<void> {
  await act('/', async (p) => {
    await keepDefaultBranding(p)
    return `Kept the ${PRODUCT_NAME} look. You can still brand it any time under Firm settings → Branding.`
  })
}
