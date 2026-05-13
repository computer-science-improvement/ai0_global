# --- builder ---
FROM node:20-alpine AS builder
WORKDIR /repo
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
