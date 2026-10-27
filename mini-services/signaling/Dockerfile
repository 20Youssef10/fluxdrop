# FluxDrop signaling server — Socket.IO room/pairing/ICE relay on :3003.
# Stateless after session establishment; never touches file data.

FROM oven/bun:1-slim
WORKDIR /app

# Lockfile-pinned install (bun.lock ships with the service).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src

# TURN wiring (TURN_URL, TURN_URL_TCP, TURN_SECRET, TURN_REALM) is injected
# at runtime by docker-compose.yml so credentials never bake into the image.

EXPOSE 3003
CMD ["bun", "src/index.ts"]
