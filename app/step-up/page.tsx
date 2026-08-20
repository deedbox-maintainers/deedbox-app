import { Notices } from '@/components/ui'
import { Field, TextInput, SubmitButton, Checkbox } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { verifyStepUp, abandonStepUp } from './actions'

export default async function StepUpPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await readParams(searchParams)
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50">
      <div className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-6">
        <h1 className="mb-1 text-lg font-semibold text-neutral-900">Verify this sign-in</h1>
        <p className="mb-4 text-sm text-neutral-500">
          This sign-in came from an unrecognised device or location. Confirm your password to
          verify it is really you.
        </p>
        <Notices searchParams={sp} />
        <form action={verifyStepUp}>
          <Field label="Password">
            <TextInput name="answer" type="password" autoFocus autoComplete="current-password" />
          </Field>
          <Checkbox name="trust_device" label="Trust this device" />
          <SubmitButton>Verify</SubmitButton>
        </form>
        <form action={abandonStepUp} className="mt-3">
          <button type="submit" className="text-xs text-neutral-400 underline-offset-2 hover:underline">
            Cancel and sign in as someone else
          </button>
        </form>
      </div>
    </main>
  )
}
