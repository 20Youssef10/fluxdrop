# FluxDrop web app — multi-stage build.
#
# Stage 1 (deps)  : install with the lockfile, generate the Prisma client.
# Stage 2 (build) : `bun run build` → standalone Next.js output (server.js +
#                   pruned node_modules; the build script also merges
#                   .next/static and public into .next/standalone).
# Stage 3 (run)   : plain Node 22 slim — the standalone server is a Node
#                   program (Bun cannot exec it reliably), so the runtime
#                   stage swaps to node:22-slim and just copies the output.

# syntax=docker/dockerfile:1

# ---------- Stage 1: dependencies ----------
FROM oven/bun:1 AS deps
WORKDIR /app

# Lockfile-pinned install for a reproducible dependency tree.
COPY package.json bun.lock ./
# Schema is needed by the codegen below (kept out of the final image).
COPY prisma ./prisma

# Defensive: nothing currently imports @prisma/client in the build graph
# (src/lib/db.ts is unwired), so generation isn't strictly required — but it
# is cheap insurance: if any module in the graph ever statically imports the
# client, a missing generated client would fail `next build`. Remove this
# step if you trim the Prisma deps entirely.
RUN bun install --frozen-lockfile && bunx prisma generate

# ---------- Stage 2: build ----------
FROM oven/bun:1 AS build
WORKDIR /app

# DATABASE_URL is defensive (see deps stage): page-data collection stays
# green even if the Prisma client ever gets statically imported.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=file:/app/db/custom.db

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY next.config.ts tsconfig.json next-env.d.ts postcss.config.mjs tailwind.config.ts eslint.config.mjs ./
COPY src ./src
COPY public ./public

# Runs `next build` + the build script's cp of .next/static and public into
# .next/standalone — all inside the image, so the standalone output is
# complete and self-contained.
RUN bun run build

# ---------- Stage 3: runtime ----------
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# The standalone tree already contains server.js, pruned node_modules,
# .next/static and public (merged by the build script). The static/public
# COPYs are redundant-but-idempotent, keeping the runtime correct even if
# the build script is ever changed.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
