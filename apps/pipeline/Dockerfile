# Monorepo: build context = repo root (see docker-compose.yml).

FROM node:26-alpine

WORKDIR /repo

RUN npm install -g pnpm@9.15.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/pipeline/package.json ./apps/pipeline/

RUN pnpm install --frozen-lockfile --filter pipeline...

COPY apps/pipeline ./apps/pipeline

WORKDIR /repo/apps/pipeline

CMD ["pnpm", "run", "sync"]
