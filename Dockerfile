FROM oven/bun:1.4-slim AS deps

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM deps AS build

WORKDIR /app
COPY cli.ts plugin.ts index.ts ./
COPY server ./server
COPY src ./src
COPY packages/chat-room-channeld ./packages/chat-room-channeld
RUN bun run build:cli && bun run build:channeld-mock

# The server speaks Node's HTTP and SQLite modules, so the image runtime is
# Node even though Bun installs dependencies and bundles the CLI at build time.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production \
    CHAT_ROOM_SERVER_HOST=0.0.0.0 \
    CHAT_ROOM_SERVER_PORT=4399 \
    CHAT_ROOM_STATE_DIR=/data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/state/pg-worker.mjs /app/src/state/pg-worker.mjs
COPY --from=build /app/src/state/pg-sql.mjs /app/src/state/pg-sql.mjs
COPY --from=build /app/src/tui ./src/tui
COPY --from=build /app/packages/chat-room-channeld/dist ./packages/chat-room-channeld/dist
COPY package.json ./
COPY LICENSE ./
COPY server ./server

RUN mkdir -p /data && chown -R 10001:10001 /app /data
USER 10001:10001
EXPOSE 4399
VOLUME ["/data"]

CMD ["node", "dist/cli.js"]
