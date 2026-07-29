# ADR-001: WebRTC DataChannel for File Transport

## Status
Accepted

## Context
Build a peer-to-peer file transfer application that sends files directly between browser-based devices. The system must work on local networks without requiring cloud storage or server-side file relay. Files should never touch a server.

## Decision
Use WebRTC DataChannel as the sole transport mechanism for file data between peers.

## Rationale

1. **True P2P**: DataChannel establishes a direct connection between browsers. File bytes flow peer-to-peer after session setup. The signaling server only relays SDP offers/answers and ICE candidates.

2. **Mandatory Encryption**: WebRTC mandates DTLS for data channels and SRTP for media. Even without explicit implementation, all DataChannel traffic is encrypted in transit.

3. **Ordered Delivery**: DataChannel supports ordered mode (`ordered: true`), which guarantees chunk ordering. This simplifies receiver logic and eliminates out-of-order reassembly complexity.

4. **Browser-Native**: No plugins, no external libraries. Supported in Chrome 90+, Firefox 90+, Safari 15+, and Edge 90+.

5. **Flow Control**: Built-in `bufferedAmount` property enables natural backpressure without custom flow control protocols.

## Options Considered

| Option | Pros | Cons | Complexity | When Valid |
|--------|------|------|------------|-----------|
| WebRTC DataChannel | True P2P, encrypted, browser-native | ICE negotiation, browser quirks | Medium | Direct P2P required |
| WebSocket relay | Simple, reliable | Server handles all data, scaling cost, privacy | Low | Server relay acceptable |
| HTTP POST/upload | Universal, simple | No P2P, polling for progress | Low | One-way upload only |
| WebTransport | Modern, streams | Limited browser support (Chrome 97+) | High | Future optimization |

## Trade-offs Accepted

- **ICE negotiation complexity**: Must handle ICE gathering, candidate exchange, and connection state monitoring. Mitigated by using public STUN servers and comprehensive state machine.
- **Safari DataChannel limits**: Safari may impose lower message size limits (~256 KB). Mitigated by adaptive chunk sizing per browser.
- **No fallback for restrictive networks**: Some corporate/firewalled networks block UDP. Mitigated by STUN server selection and future TURN relay extension.

## Consequences

- **Positive**: Encrypted P2P transfer, no server file relay, works across NATs (most cases), browser-native
- **Negative**: Must handle connection failures, browser-specific quirks, ICE negotiation delays
- **Mitigation**: Exponential backoff reconnection, resume protocol, browser detection for chunk sizing, comprehensive error taxonomy

## Revisit Trigger
- If WebTransport achieves broad browser support (Safari, Firefox) and offers significant performance gains
- If DataChannel reliability issues emerge in production at scale
- If TURN relay becomes necessary for >50% of users
