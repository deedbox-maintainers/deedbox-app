import { Notices } from '@/components/ui'
import { Field, TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { signIn } from './actions'
import { readBrand } from '@/lib/brand'

export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await readParams(searchParams)
  const brand = await readBrand()
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50">
      <div className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-6">
        <h1 className="mb-2">
          {/* the installation's lockup — the firm's own if white-labelled, else the product's */}
          <img src={brand.logoHref} alt={brand.name} className="h-10 w-auto" />
        </h1>
        <p className="mb-4 text-sm text-neutral-500">Sign in to continue.</p>
        <Notices searchParams={sp} />
        <form action={signIn}>
          <Field label="Login">
            <TextInput name="login" autoComplete="username" autoFocus />
          </Field>
          <Field label="Password">
            <TextInput name="secret" type="password" autoComplete="current-password" />
          </Field>
          <SubmitButton>Sign in</SubmitButton>
        </form>
        <p className="mt-4 text-xs text-neutral-500">
          External examiner?{' '}
          <a href="/examiner/sign-in" className="underline hover:text-neutral-700">
            Sign in to the examination workspace.
          </a>
        </p>
      </div>
    </main>
  )
}
