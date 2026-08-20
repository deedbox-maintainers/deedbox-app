'use client'

// The root error boundary (public pages: sign-in, portal, share, sign).
// The honest shape: a moment's pressure, retry — never a claim about the
// instance's state.

export default function RootError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-lg font-semibold">That didn&rsquo;t load</h1>
      <p className="mt-2 text-sm text-neutral-600">
        The system was momentarily busy and this page could not be prepared. Try again.
      </p>
      <button
        onClick={() => reset()}
        className="mt-4 rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
      >
        Try again
      </button>
    </div>
  )
}
