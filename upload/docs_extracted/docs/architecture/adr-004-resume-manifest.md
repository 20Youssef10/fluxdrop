# ADR-004: IndexedDB for Resume State Persistence

## Status
Accepted

## Context
Transfers may be interrupted by tab closure, network drops, device sleep, or browser crashes. The application must persist enough state to resume transfers from the last verified chunk, without requiring the user to restart from the beginning.

## Decision
Use IndexedDB to store transfer manifests, chunk completion status, and device preferences. No file content is stored in IndexedDB.

## IndexedDB Schema

### Database: `fluxdrop`

#### Object Store: `transfers`
```typescript
interface TransferRecord {
  transferId: string;          // Primary key
  manifest: TransferManifest;  // Full manifest for resume
  status: TransferStatus;      // Current state
  chunksSent: number[];        // Indices of sent chunks (sender)
  chunksReceived: number[];    // Indices of received chunks (receiver)
  createdAt: number;           // Unix timestamp ms
  updatedAt: number;
  expiresAt: number;           // Auto-cleanup after 24h
}
```

#### Object Store: `chunks`
```typescript
interface ChunkRecord {
  key: string;                 // "{transferId}:{chunkIndex}"
  data: ArrayBuffer;           // Chunk payload (receiver only)
  receivedAt: number;
}
```

#### Object Store: `preferences`
```typescript
interface DevicePreference {
  deviceId: string;            // Primary key
  alias: string;               // User-assigned name
  createdAt: number;
  lastSeen: number;
}
```

## Rationale

1. **Sufficient Quota**: IndexedDB provides 50 MB+ quota in most browsers (Chrome: 80% of disk, Firefox: 2 GB, Safari: varies). Manifest metadata is small (~1 KB per transfer). Chunk data storage is bounded by resume window.

2. **Structured Storage**: IndexedDB stores structured objects natively. No JSON serialization needed for complex transfer state (arrays, nested objects).

3. **Async API**: All operations are asynchronous. Never blocks the main thread during transfer.

4. **Wide Support**: Supported in all target browsers (Chrome, Firefox, Safari, Edge).

5. **Transaction Safety**: IndexedDB transactions ensure atomic reads/writes. No partial state corruption.

## Options Considered

| Option | Pros | Cons | Complexity | When Valid |
|--------|------|------|------------|-----------|
| IndexedDB | Large quota, structured, async, transactional | Complex API, async only | Medium | Persistent structured state needed |
| localStorage | Simple API, synchronous | 5 MB limit, synchronous, string only | Low | Small config data only |
| Cache API | Good for binary data | Not designed for structured state, no indexing | Medium | Service worker caching |
| None (in-memory) | Simplest | No resume capability | None | Simple demos only |

## Trade-offs Accepted

- **API complexity**: IndexedDB has a verbose, callback-based API. Mitigated by thin wrapper abstraction (`ResumeStore` class).
- **Quota variability**: Different browsers have different quotas. Mitigated by checking `navigator.storage.estimate()` and warning users if quota is low.
- **No file content storage**: IndexedDB stores only metadata and chunk completion status, not file payloads. This is intentional—file content is too large and should come from the original file (sender) or reassembly buffer (receiver).

## Consequences

- **Positive**: Resume capability, persistent state across browser restarts, transactional safety
- **Negative**: API complexity, quota limits, no offline file storage
- **Mitigation**: Wrapper abstraction, quota checking, fallback to in-memory state if IndexedDB unavailable

## Revisit Trigger
- If storage quotas become insufficient for resume metadata
- If browser support for IndexedDB degrades
- If Cache API evolves to support structured queries
