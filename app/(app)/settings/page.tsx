// Firm settings screen: every key grouped by category with description,
// current value, neutral default, scheduled values shown loudly, and a
// history drawer per key. Changes preview their effect through the value
// form; the held-funds close-condition row carries its hard-guard note.

import { requirePrincipal } from '@/lib/auth'
import { settingsScreen } from '@/lib/reads/config'
import { Page, Panel, Badge, Notices, fmtDateTime, fmtJson } from '@/components/ui'
import { TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { changeSettingAction, revertSettingAction, cancelScheduledAction, setBrandingAction, resetBrandingAction } from './actions'
import { readBrand, PRODUCT_NAME } from '@/lib/brand'

function ValueInput({ s }: { s: Awaited<ReturnType<typeof settingsScreen>>[number] }) {
  const current = fmtJson(s.currentValue)
  if (s.valueType === 'boolean') {
    return (
      <Select name="value" defaultValue={current}>
        <option value="true">on</option>
        <option value="false">off</option>
      </Select>
    )
  }
  if (s.valueType === 'choice' && Array.isArray(s.allowedValues)) {
    return (
      <Select name="value" defaultValue={current}>
        {s.allowedValues.map((v) => (
          <option key={String(v)} value={String(v)}>
            {String(v)}
          </option>
        ))}
      </Select>
    )
  }
  return <TextInput name="value" defaultValue={current === 'null' ? '' : current} className="w-44" />
}

export default async function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const rows = await settingsScreen(p)
  const categories = [...new Set(rows.map((r) => r.category))].sort()
  const brand = await readBrand()
  return (
    <Page
      title="Firm settings"
      lead="Every setting always has a value: the firm's, or the neutral default. Changes are append-only history — schedule one ahead, or revert to the default, and every change is registered with before and after."
    >
      <Notices searchParams={sp} />

      <Panel title="Branding — make it your firm's">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-[auto_1fr]">
          <div className="min-w-56">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">How it looks now</p>
            <div className="rounded border border-neutral-200 bg-neutral-50 p-4">
              <img src={brand.logoHref} alt={brand.name} className="h-10 w-auto" />
              <p className="mt-2 text-sm text-neutral-700">
                <span className="font-medium">{brand.name}</span>
                {brand.isDefault ? (
                  brand.decided ? (
                    <Badge tone="blue">{PRODUCT_NAME} look — kept by choice</Badge>
                  ) : (
                    <Badge tone="amber">{PRODUCT_NAME} default look</Badge>
                  )
                ) : (
                  <Badge tone="green">your firm's branding</Badge>
                )}
              </p>
              <p className="mt-1 flex items-center gap-2 text-xs text-neutral-500">
                <img src={brand.iconHref} alt="" className="h-4 w-4" /> browser-tab icon
              </p>
            </div>
            {!brand.isDefault ? (
              <form action={resetBrandingAction} className="mt-3">
                <SubmitButton tone="quiet">Reset to the {PRODUCT_NAME} default</SubmitButton>
              </form>
            ) : null}
          </div>
          <div>
            <p className="mb-3 text-sm text-neutral-600">
              Every installation starts with the {PRODUCT_NAME} name and logo. Give this one your firm's own —
              the name, a logo for the header and sign-in page, a small square icon for the browser tab,
              and your two brand colours — and every screen, page title and signed document will carry
              them. Leave a field blank to keep the {PRODUCT_NAME} default for that part.
            </p>
            <form action={setBrandingAction} encType="multipart/form-data" className="space-y-3">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-700">Display name</span>
                  <input
                    name="display_name"
                    defaultValue={brand.isDefault ? '' : brand.name}
                    placeholder="e.g. your firm's short name"
                    maxLength={60}
                    className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
                  />
                </label>
                <div />
                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-700">Logo (SVG or PNG, up to 512 KB — a wide lockup works best)</span>
                  <input name="logo" type="file" accept=".svg,.png,.jpg,.jpeg,.webp,image/*" className="block w-full text-sm" />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-700">Browser-tab icon (square SVG, PNG or ICO)</span>
                  <input name="icon" type="file" accept=".svg,.png,.ico,image/*" className="block w-full text-sm" />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-700">Primary colour (hex, e.g. #0A3A78)</span>
                  <input
                    name="colour_primary"
                    defaultValue={brand.colourPrimary ?? ''}
                    placeholder="#0A3A78"
                    className="w-40 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-neutral-700">Secondary colour (hex)</span>
                  <input
                    name="colour_secondary"
                    defaultValue={brand.colourSecondary ?? ''}
                    placeholder="#1B2430"
                    className="w-40 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
                  />
                </label>
              </div>
              <SubmitButton>Save branding</SubmitButton>
            </form>
          </div>
        </div>
      </Panel>

      {categories.map((cat) => (
        <Panel key={cat} title={cat}>
          <div className="divide-y divide-neutral-100">
            {rows
              .filter((r) => r.category === cat)
              .map((s) => (
                <div key={s.key} className="grid grid-cols-1 gap-2 py-3 md:grid-cols-[1fr_auto]">
                  <div>
                    <p className="text-sm font-medium text-neutral-800">{s.key}</p>
                    <p className="text-sm text-neutral-500">{s.description}</p>
                    {s.key === 'matter.close_condition_held_funds' ? (
                      <p className="text-xs text-amber-700">
                        Whatever this says, execution of a close is always stopped by the hard rule
                        that no client money may remain on the matter.
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-neutral-400">
                      Neutral default: <code>{fmtJson(s.neutralDefault)}</code>
                      {fmtJson(s.currentValue) !== fmtJson(s.neutralDefault) ? (
                        <Badge tone="blue">firm value in force</Badge>
                      ) : null}
                    </p>
                    {s.scheduled.map((sc) => (
                      <p key={sc.row} className="mt-1 text-xs">
                        <Badge tone="amber">
                          scheduled: {fmtJson(sc.value)} from {fmtDateTime(sc.effectiveFrom)}
                        </Badge>{' '}
                        <form action={cancelScheduledAction} className="inline">
                          <input type="hidden" name="key" value={s.key} />
                          <input type="hidden" name="row" value={sc.row} />
                          <button type="submit" className="text-red-700 underline-offset-2 hover:underline">
                            cancel
                          </button>
                        </form>
                      </p>
                    ))}
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-neutral-400">History</summary>
                      <p className="text-xs text-neutral-400">
                        The full change history is on the{' '}
                        <a className="text-sky-700 hover:underline" href={`/security/register?event_kind=setting.changed`}>
                          register
                        </a>
                        .
                      </p>
                    </details>
                  </div>
                  <div className="flex items-start gap-2">
                    <form action={changeSettingAction} className="flex items-center gap-2">
                      <input type="hidden" name="key" value={s.key} />
                      <input type="hidden" name="value_type" value={s.valueType} />
                      <ValueInput s={s} />
                      <TextInput
                        name="effective_from"
                        type="datetime-local"
                        className="w-48"
                        title="Leave empty to take effect now"
                      />
                      {s.key === 'conflict.restricted_match_contact' ? (
                        <TextInput name="staff_login" placeholder="staff login (named_staff)" className="w-40" />
                      ) : null}
                      <SubmitButton tone="quiet">Change</SubmitButton>
                    </form>
                    <form action={revertSettingAction}>
                      <input type="hidden" name="key" value={s.key} />
                      <SubmitButton tone="quiet">Revert</SubmitButton>
                    </form>
                  </div>
                </div>
              ))}
          </div>
        </Panel>
      ))}
    </Page>
  )
}
