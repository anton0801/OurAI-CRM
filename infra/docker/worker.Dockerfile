# Castlane CRM — background worker (jobs, outbox, schedules) and one-shot CLIs (migrate, bootstrap)
# Build from the repository root: docker build -f infra/docker/worker.Dockerfile -t castlane-worker .
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @castlane/worker build \
 && pnpm --filter @castlane/worker deploy --prod --legacy /out \
 && cp -r apps/worker/dist /out/dist \
 && mkdir -p /out/db && cp -r packages/database/migrations packages/database/sql /out/db/

FROM node:22-bookworm-slim AS runtime
# ffmpeg provides ffprobe for video/audio metadata and previews (optional but recommended).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production CASTLANE_DB_ASSETS_DIR=/app/db FFPROBE_PATH=/usr/bin/ffprobe FFMPEG_PATH=/usr/bin/ffmpeg
RUN groupadd --system --gid 10001 castlane && useradd --system --uid 10001 --gid castlane castlane
WORKDIR /app
COPY --from=build --chown=castlane:castlane /out ./
USER castlane
# Default: run the worker. One-shot commands:
#   node dist/cli/migrate.js
#   node dist/cli/bootstrap-owner.js --email owner@company.example --name "Owner Name"
CMD ["node", "--enable-source-maps", "dist/index.js"]
