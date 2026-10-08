# --- builder ---
FROM node:20-alpine AS builder
WORKDIR /repo

# Vite bakes VITE_* envs into the bundle at build time, so they must be present
# during `pnpm build` — passed as --build-arg from CI / compose. A build with no
# sign-in method fails (spec 028, vite.config.ts), so when NEITHER is given the
# image defaults to token sign-in. Compose passes `${VITE_AUTH_MODE:-}`, i.e. an
# EMPTY string rather than nothing, hence the shell default in the RUN below
# instead of an ARG default.
ARG VITE_AUTH_MODE=
ARG VITE_TG_BOT_USERNAME=
# Public origin for the Open Graph tags (spec 026); empty: the default in src/lib/public-url.ts.
ARG VITE_PUBLIC_URL=
ENV VITE_AUTH_MODE=$VITE_AUTH_MODE
ENV VITE_TG_BOT_USERNAME=$VITE_TG_BOT_USERNAME
ENV VITE_PUBLIC_URL=$VITE_PUBLIC_URL

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json apps/dashboard/
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate && pnpm install --frozen-lockfile --filter dashboard
COPY apps/dashboard apps/dashboard
RUN if [ -z "$VITE_AUTH_MODE" ] && [ -z "$VITE_TG_BOT_USERNAME" ]; then export VITE_AUTH_MODE=token; fi; \
    pnpm --filter dashboard run build

# --- runner ---
FROM nginx:1.27-alpine
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 80
