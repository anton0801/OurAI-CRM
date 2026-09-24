# Castlane CRM — web (Next.js standalone server: UI + REST API)
# Build from the repository root: docker build -f infra/docker/web.Dockerfile -t castlane-web .
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && NODE_ENV=production pnpm --filter @castlane/web build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd --system --gid 10001 castlane && useradd --system --uid 10001 --gid castlane castlane
WORKDIR /app
COPY --from=build --chown=castlane:castlane /repo/apps/web/.next/standalone ./
COPY --from=build --chown=castlane:castlane /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=castlane:castlane /repo/apps/web/public ./apps/web/public
USER castlane
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
