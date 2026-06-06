# --- builder ---
FROM node:20-alpine AS builder
WORKDIR /repo

# Vite bakes VITE_* envs into the bundle at build time, so they must be present
# during `pnpm build` — passed as --build-arg from CI / compose. Empty defaults
# fall back to dev-bypass auth.
ARG VITE_AUTH_MODE=
ARG VITE_TG_BOT_USERNAME=
ENV VITE_AUTH_MODE=$VITE_AUTH_MODE
ENV VITE_TG_BOT_USERNAME=$VITE_TG_BOT_USERNAME

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json apps/dashboard/
RUN corepack enable && pnpm install --frozen-lockfile --filter dashboard
COPY apps/dashboard apps/dashboard
RUN pnpm --filter dashboard run build

# --- runner ---
FROM nginx:1.27-alpine
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 80
