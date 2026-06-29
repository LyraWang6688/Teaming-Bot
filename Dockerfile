FROM node:20-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ENV PNPM_CONFIG_REGISTRY=https://registry.npmmirror.com
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories
RUN apk add --no-cache curl
RUN corepack enable
RUN npm install -g @larksuite/cli
ENV LARKSUITE_CLI_CONFIG_DIR=/app/.lark-cli

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN corepack prepare pnpm@9.0.0 --activate \
  && pnpm install --frozen-lockfile

FROM base AS builder
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG PROJECT_PUBLIC_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV PROJECT_PUBLIC_URL=$PROJECT_PUBLIC_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack prepare pnpm@9.0.0 --activate \
  && pnpm build

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV LARKSUITE_CLI_CONFIG_DIR=/app/.lark-cli
RUN addgroup -S nextjs && adduser -S nextjs -G nextjs
RUN mkdir -p /app/.lark-cli && chown nextjs:nextjs /app/.lark-cli
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
USER nextjs
EXPOSE 3000
CMD ["pnpm", "start"]
