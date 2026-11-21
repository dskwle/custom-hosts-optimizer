# ---------- 构建阶段：装全量依赖，esbuild 打成单文件 ----------
FROM node:22-alpine AS build
WORKDIR /app

ARG NPM_REGISTRY=https://registry.npmjs.org

COPY package.json package-lock.json ./
# 缓存挂载让重复构建跳过下载；首次仍需完整拉一次
RUN --mount=type=cache,target=/root/.npm \
    npm ci --registry=$NPM_REGISTRY --no-audit --no-fund --prefer-offline

COPY tsconfig.json ./
COPY src ./src
COPY server ./server
RUN npm run local:build

# ---------- 运行阶段：只保留运行时依赖与产物 ----------
FROM node:22-alpine AS runtime
WORKDIR /app

# TZ 让日志与抓取时间按本地时区显示（alpine 需显式装 tzdata）
RUN apk add --no-cache tzdata

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8788 \
    TZ=Asia/Shanghai

ARG NPM_REGISTRY=https://registry.npmjs.org

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --registry=$NPM_REGISTRY --no-audit --no-fund --prefer-offline

COPY --from=build /app/dist-server ./dist-server
COPY public ./public

# 数据目录由 compose 挂载；镜像内先建好并归给运行用户
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/local/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/index.mjs"]
