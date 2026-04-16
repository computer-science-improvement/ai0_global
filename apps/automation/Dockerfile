# Monorepo: build context must be repo root (pnpm-lock.yaml + pnpm-workspace.yaml).
# docker compose: context: ., dockerfile: apps/automation/Dockerfile

FROM node:20-alpine AS builder

WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/automation/package.json ./apps/automation/

RUN pnpm install --frozen-lockfile --filter automation...

COPY apps/automation ./apps/automation

RUN pnpm --filter automation run build

# --- Production ---
FROM node:20-alpine AS runner

WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/automation/package.json ./apps/automation/

RUN pnpm install --frozen-lockfile --filter automation... --prod

COPY --from=builder /repo/apps/automation/dist ./apps/automation/dist
COPY apps/automation/config ./apps/automation/config

WORKDIR /repo/apps/automation

EXPOSE 3000

CMD ["node", "dist/main"]
