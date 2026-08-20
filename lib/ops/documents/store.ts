// The documents module's byte-store seam. Staff uploads and version adds
// put bytes on the hosted platform's object storage through this seam —
// the same service, the same bytes-first ordering the intake door proved —
// bound at boot by lib/bindings, injectable for tests. Unbound, every
// byte-carrying operation refuses typed: a document row must never name
// bytes that did not land.

import { OperationRefused } from '@/lib/db'
import { seamSlot } from '@/lib/seam-slot'

export interface StoredBytes {
  storageRef: string
  contentType: string
}

/** matter null → the templates/ path prefix (one bucket, prefix separation). */
export type DocumentByteStore = (input: {
  matter: number | null
  filename: string
  bytes: Buffer
}) => Promise<StoredBytes>

/** The read half: fetch stored bytes back for generation and downloads. */
export type DocumentByteFetch = (storageRef: string) => Promise<{
  bytes: Buffer
  contentType: string
}>

// Process-wide, not module-level: see lib/seam-slot.ts for why.
const byteStoreSlot = seamSlot<DocumentByteStore>('document-byte-store')
const byteFetchSlot = seamSlot<DocumentByteFetch>('document-byte-fetch')

export function setDocumentByteStore(store: DocumentByteStore | null): void {
  byteStoreSlot.set(store)
}

export function setDocumentByteFetch(fetcher: DocumentByteFetch | null): void {
  byteFetchSlot.set(fetcher)
}

export function requireByteStore(): DocumentByteStore {
  const byteStore = byteStoreSlot.get()
  if (!byteStore) {
    throw new OperationRefused(
      'document_storage_unbound',
      'no document byte store is bound on this installation',
    )
  }
  return byteStore
}

export function requireByteFetch(): DocumentByteFetch {
  const byteFetch = byteFetchSlot.get()
  if (!byteFetch) {
    throw new OperationRefused(
      'document_storage_unbound',
      'no document byte fetch is bound on this installation',
    )
  }
  return byteFetch
}
