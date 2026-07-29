# ADR-003: Binary Wire Protocol for Chunk Transfer

## Status
Accepted

## Context
File data is transferred over WebRTC DataChannel as fixed-size chunks. Each chunk needs a header to identify the transfer, chunk index, and message type. The protocol must be efficient (minimal overhead per chunk) and easy to parse on the hot path.

## Decision
Use a binary ArrayBuffer protocol with a fixed 9-byte header for chunk messages, and JSON for control messages (manifest, cancel).

## Protocol Specification

### Chunk Data Message (0x01)
```
Offset  Size  Field
0       1     Message type (0x01 = CHUNK_DATA)
1       4     Transfer ID (UUID as raw bytes)
5       4     Chunk index (uint32, big-endian)
9       N     Payload (raw file bytes)
```

### Chunk ACK Message (0x02)
```
Offset  Size  Field
0       1     Message type (0x02 = CHUNK_ACK)
1       4     Transfer ID
5       4     Chunk index
9       1     Status (0x01 = OK, 0x02 = ERROR)
```

### Control Messages (0x03-0x09)
JSON-encoded with `type` field for manifest, cancel, resume, etc.

## Rationale

1. **Minimal Overhead**: 9-byte header for chunk data. For a 1 MB chunk, overhead is 0.0009%. JSON would add 33%+ overhead from Base64 encoding alone.

2. **Fast Parsing**: Fixed-offset fields enable O(1) parsing without schema lookup or string splitting. Critical for the hot path (every chunk).

3. **Native Binary**: WebRTC DataChannel natively supports ArrayBuffer. No encoding/decoding needed.

4. **Versioning**: First byte serves as message type. Future versions can add new message types without breaking existing parsers (forward-compatible).

5. **UUID as Transfer ID**: 4-byte UUID (truncated) provides sufficient uniqueness for local transfers while keeping header small.

## Options Considered

| Option | Pros | Cons | Complexity | When Valid |
|--------|------|------|------------|-----------|
| Binary ArrayBuffer | Minimal overhead, fast parsing | Harder to debug | Medium | High-throughput transfer |
| JSON + Base64 | Easy to debug, human-readable | 33% overhead, encoding cost | Low | Prototyping, debugging |
| MessagePack | Compact, schema-less | Extra dependency, parsing overhead | Medium | Schema flexibility needed |
| Protocol Buffers | Schema evolution, compact | Extra dependency, build step | High | Complex protocol with versions |

## Trade-offs Accepted

- **Debugging difficulty**: Binary data is harder to inspect in browser DevTools. Mitigated by building a debug visualization tool that parses and displays chunk headers.
- **Header versioning**: Must maintain backward compatibility. Mitigated by reserving message type bytes for future use.
- **UUID truncation**: 4-byte UUID (from 16-byte UUID) provides ~4 billion values. Sufficient for local transfers with low collision probability.

## Consequences

- **Positive**: Optimal throughput, native binary support, fast parsing, versioning support
- **Negative**: Debugging requires tooling, protocol must be documented carefully
- **Mitigation**: Build debug tool, maintain protocol documentation, add logging for parsed headers

## Revisit Trigger
- If chunk sizes decrease significantly (e.g., <10 KB), JSON overhead becomes acceptable
- If protocol needs complex schema evolution (multiple versions coexisting)
- If debugging burden outweighs performance benefits
