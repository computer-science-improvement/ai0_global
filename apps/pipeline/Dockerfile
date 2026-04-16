# Monorepo: build context = repo root (see docker-compose.yml).

FROM node:20-alpine

WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/pipeline/package.json ./apps/pipeline/

RUN pnpm install --frozen-lockfile --filter pipeline...

COPY apps/pipeline ./apps/pipeline

WORKDIR /repo/apps/pipeline

CMD ["pnpm", "run", "sync"]
