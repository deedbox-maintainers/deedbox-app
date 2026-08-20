// The examination workspace's own door. The credential is the
// grant's shown-once secret, never a staff login.

import { Notices } from '@/components/ui'
import { readBrand } from '@/lib/brand'
import { Field, TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { signInExaminer } from './actions'

export default async function ExaminerSignInPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await readParams(searchParams)
  const brand = await readBrand()
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50">
      <div className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-6">
        <h1 className="mb-1 text-lg font-semibold text-neutral-900">{brand.name} — examination</h1>
        <p className="mb-4 text-sm text-neutral-500">
          Sign in with the access details the firm issued to you. Your access is read-only,
          limited to the examined period, and every read is recorded.
        </p>
        <Notices searchParams={sp} />
        <form action={signInExaminer}>
          <Field label="Login">
            <TextInput name="login" autoComplete="username" autoFocus />
          </Field>
          <Field label="Access secret">
            <TextInput name="secret" type="password" autoComplete="current-password" />
          </Field>
          <SubmitButton>Enter the workspace</SubmitButton>
        </form>
        <p className="mt-4 text-xs text-neutral-500">
          Firm staff?{' '}
          <a href="/sign-in" className="underline hover:text-neutral-700">
            Sign in here.
          </a>
        </p>
      </div>
    </main>
  )
}
