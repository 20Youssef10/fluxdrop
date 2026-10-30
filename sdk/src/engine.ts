// @fluxdrop/sdk — engine re-exports.
//
// The SDK's engine layer IS the production code from the FluxDrop web client
// (src/lib/fluxdrop/*). Those modules are framework-agnostic by design: no
// React, no next/* imports, no window access at module scope — they run in
// browsers, workers, bun and node alike. The SDK adds nothing to them; it
// just re-exports them with a stable package surface so embedders never
// depend on repo-internal paths.
//
// Wire-format conformance of these modules is locked by
// scripts/protocol-conformance.ts (docs/protocol-spec.md §10 golden vectors).

export * from '../../src/lib/fluxdrop/protocol'
export * from '../../src/lib/fluxdrop/encoding'
export * from '../../src/lib/fluxdrop/compress'
export * from '../../src/lib/fluxdrop/checksum'
export * from '../../src/lib/fluxdrop/format'
