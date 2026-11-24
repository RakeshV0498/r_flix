# r_flix — small image for a Raspberry Pi 3B+ (1 GB RAM). Multi-arch: builds natively on arm64/armv7/amd64.
FROM node:22-alpine

# Cap the V8 heap well under the container limit so the Pi never swaps. node:sqlite is
# still flagged "experimental" by Node (it is stable in practice), so silence that one warning.
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=160 --disable-warning=ExperimentalWarning" \
    RFLIX_DATA=/data

WORKDIR /app

# Dependencies first (cached layer). hls.js is gzipped once here so the Pi never compresses per request.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force \
 && gzip -9 -c node_modules/hls.js/dist/hls.min.js > node_modules/hls.js/dist/hls.min.js.gz

COPY src ./src
COPY public ./public

# The database (users, servers, settings) and the encryption key live here. Mount a volume so
# they survive rebuilds. Created and owned by the unprivileged user so a fresh volume is writable.
RUN mkdir /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/api/health" >/dev/null || exit 1

CMD ["node", "src/server.js"]
