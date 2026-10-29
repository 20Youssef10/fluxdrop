// v4 (1.7): streaming Merkle tree over per-chunk SHA-256 leaves.
//
// Tree shape: binary, leaves are the SHA-256 of each 64 KB chunk (final chunk
// short); an odd node at any level pairs with a duplicate of itself (Bitcoin
///BIP-style); a single leaf is its own root. The root hex is sealed into the
// manifest (`merkle: { root, leaves }`) BEFORE the room is created, so it is
// covered by the E2E manifest seal when PAKE is active.
//
// Receiver side rebuilds the identical tree from the bytes it actually stored
// and compares roots at completion — an independent integrity check that does
// NOT share code paths with the per-file checksum verification (defense in
// depth: a bug in either path can't hide behind the other).

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? (data.slice().buffer as ArrayBuffer) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hashPair(aHex: string, bHex: string): Promise<string> {
  const a = hexToBytes(aHex)
  const b = hexToBytes(bHex)
  const combined = new Uint8Array(a.length + b.length)
  combined.set(a, 0)
  combined.set(b, a.length)
  return sha256Hex(combined)
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Build the Merkle root from an ordered list of leaf hashes (hex).
 * Odd levels duplicate the last node. Returns the root hex.
 */
export async function buildMerkleRoot(leaves: string[]): Promise<string> {
  if (leaves.length === 0) return sha256Hex(new Uint8Array(0))
  let level = [...leaves]
  while (level.length > 1) {
    const next: string[] = []
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]
      const b = i + 1 < level.length ? level[i + 1] : a // duplicate-last
      next.push(await hashPair(a, b))
    }
    level = next
    // Yield between levels on large trees (16K leaves → 14 levels).
    if (level.length > 64) await new Promise((r) => setTimeout(r, 0))
  }
  return level[0]
}

export interface MerkleProgress {
  leavesDone: number
  leavesTotal: number
}

/**
 * Compute the transfer Merkle root by reading every global chunk exactly once.
 *
 * `readChunk(chunkIndex)` must return the bytes for that global chunk index
 * (64 KB layout, final chunk short) or null when out of range — the sender
 * implements it over the original files via the slice plan; the receiver over
 * its assembled bytes. The tree is built bottom-up from the per-chunk leaf
 * hashes, and progress is reported per leaf for hashing UI reuse.
 */
export async function computeTransferMerkle(
  readChunk: (chunkIndex: number) => Promise<ArrayBuffer | null>,
  totalChunks: number,
  onProgress?: (p: MerkleProgress) => void
): Promise<{ root: string; leaves: string[] }> {
  const leaves: string[] = []
  for (let c = 0; c < totalChunks; c++) {
    const bytes = await readChunk(c)
    if (!bytes) break
    leaves.push(await sha256Hex(bytes))
    onProgress?.({ leavesDone: c + 1, leavesTotal: totalChunks })
    if ((c & 63) === 63) await new Promise((r) => setTimeout(r, 0))
  }
  const root = await buildMerkleRoot(leaves)
  return { root, leaves }
}
