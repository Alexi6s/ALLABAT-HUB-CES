# ALABATT-CES container image.
# Status: written but NOT built or run by the author (no container daemon was available). Build it in your environment and
# run the smoke test in docs/OPERATIONS.md before relying on it.
#
# The app has no runtime npm dependencies, so there is no install step. It needs Node >= 22.18 (native TypeScript type
# stripping and node:sqlite).
FROM node:22-slim

# Fail the build early if the base image is older than the app supports.
RUN node -e "const [a,b]=process.versions.node.split('.').map(Number); if (a<22||(a===22&&b<18)) { console.error('Node >= 22.18 required, found '+process.versions.node); process.exit(1); }"

ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY apps ./apps
COPY scripts ./scripts
COPY docs ./docs

# Persistent state (SQLite database + private uploads) lives on a volume, owned by the unprivileged user.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD for the first start only (see docs/OPERATIONS.md), and APP_URL.
CMD ["node", "apps/api/src/server.ts"]
