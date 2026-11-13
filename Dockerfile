FROM oven/bun:1.4-slim

WORKDIR /app
ENV NODE_ENV=production \
    CHAT_ROOM_SERVER_HOST=0.0.0.0 \
    CHAT_ROOM_SERVER_PORT=4399 \
    CHAT_ROOM_STATE_DIR=/data

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY server ./server
COPY src ./src

RUN mkdir -p /data && chown -R 10001:10001 /app /data
USER 10001:10001
EXPOSE 4399
VOLUME ["/data"]

CMD ["bun", "run", "server/chat-server.ts"]
