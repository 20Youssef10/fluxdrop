# ADR-002: Socket.IO for Signaling Layer

## Status
Accepted

## Context
The application needs a signaling channel to exchange WebRTC session setup information (SDP offers/answers, ICE candidates) between peers. This channel must be reliable, handle reconnections, and support room-based isolation for multiple concurrent transfers.

## Decision
Use Socket.IO for the signaling layer. The server runs Node.js with Express and Socket.IO.

## Rationale

1. **Room Abstraction**: Socket.IO provides built-in room management (`socket.join(roomId)`, `io.to(roomId).emit()`). This maps directly to transfer sessions where exactly 2 devices share a room.

2. **Auto-Reconnect**: Socket.IO automatically attempts reconnection with exponential backoff. This handles transient network issues during signaling without custom reconnection logic.

3. **Binary Support**: Socket.IO can transmit binary data. While signaling messages are small JSON, this enables future optimizations (e.g., binary signaling for large manifests).

4. **Event-Based**: The event-driven model (`socket.on('offer', handler)`) cleanly separates concerns and makes the server code readable.

5. **Production-Proven**: Socket.IO is battle-tested for real-time signaling in production applications.

## Options Considered

| Option | Pros | Cons | Complexity | When Valid |
|--------|------|------|------------|-----------|
| Socket.IO | Rooms, auto-reconnect, binary, event-based | Protocol overhead, heavier than raw WS | Low | Room-based signaling needed |
| Raw WebSocket | Minimal, no dependency | Must implement rooms, reconnect, framing | Medium | Simple 1:1 signaling |
| Firebase Realtime DB | Managed, real-time sync | Vendor lock-in, cost, privacy | Low | Managed backend acceptable |
| Supabase Realtime | Managed, Postgres-backed | Vendor lock-in, heavier than needed | Medium | Already using Supabase |

## Trade-offs Accepted

- **Protocol overhead**: Socket.IO adds framing and protocol negotiation beyond raw WebSocket. Acceptable because signaling messages are small (SDP is ~1 KB) and infrequent (setup only).
- **Server dependency**: Must run Node.js server. This is fundamental to the architecture (signaling requires a relay point).
- **No file data through server**: Strictly enforced. Socket.IO is only for signaling, never for file payload.

## Consequences

- **Positive**: Reliable signaling, simple room management, auto-reconnect, event-driven architecture
- **Negative**: Extra dependency compared to raw WebSocket, protocol overhead
- **Mitigation**: Keep signaling messages minimal, enforce strict separation between signaling and data paths

## Revisit Trigger
- If raw WebSocket with custom room/reconnect logic becomes simpler to maintain
- If Socket.IO introduces breaking changes or security issues
- If the signaling load exceeds what a single Socket.IO server can handle (unlikely for P2P transfers)
