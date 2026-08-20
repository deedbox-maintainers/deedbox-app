'use client'

// The signed-in area's error boundary. Most arrivals here are a moment's
// database pressure, not a broken system — say so honestly, offer retry, and
// never imply the person was signed out (their session is untouched; the old
// generic error page plus a sign-in bounce read as instability in production).

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-lg font-semibold">That didn&rsquo;t load</h1>
      <p className="mt-2 text-sm text-neutral-600">
        The system was momentarily busy and this page could not be prepared. Nothing was lost and
        you are still signed in — try again.
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
