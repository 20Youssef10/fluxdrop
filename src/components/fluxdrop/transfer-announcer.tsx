'use client'

import { useEffect, useRef } from 'react'
import { useTransferStore } from '@/stores/transfer-store'

const STATE_MESSAGES: Record<string, string> = {
  IDLE: 'Ready',
  VALIDATING: 'Validating files',
  PAIRING: 'Pairing with peer',
  CONNECTING: 'Connecting to peer',
  RETRYING: 'Retrying connection',
  MANIFEST_EXCHANGE: 'Exchanging file manifest',
  TRANSFERRING: 'Transfer in progress',
  RESUMING: 'Resuming transfer',
  VERIFYING: 'Verifying file integrity',
  COMPLETE: 'Transfer complete',
  CANCELLED: 'Transfer cancelled',
  FAILED: 'Transfer failed',
  ERROR: 'Transfer error',
}

/**
 * Screen-reader-only live region that announces transfer state changes.
 * Uses aria-live="polite" so it doesn't interrupt other announcements.
 */
export function TransferAnnouncer() {
  const transferState = useTransferStore((s) => s.transferState)
  const bytesTransferred = useTransferStore((s) => s.bytesTransferred)
  const totalBytes = useTransferStore((s) => s.totalBytes)
  const lastStateRef = useRef<string>('')

  useEffect(() => {
    if (transferState !== lastStateRef.current) {
      lastStateRef.current = transferState
    }
  }, [transferState])

  const message = STATE_MESSAGES[transferState] ?? transferState
  const progressMsg =
    transferState === 'TRANSFERRING' && totalBytes > 0
      ? `${message}. ${Math.min(100, Math.round((bytesTransferred / totalBytes) * 100))} percent complete.`
      : message

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      role="status"
      className="sr-only"
    >
      {progressMsg}
    </div>
  )
}
