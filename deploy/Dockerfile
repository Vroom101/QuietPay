# One reproducible workspace image for every QuietPay backend service; the start command picks the service.
# Build context is the repository root:   docker build -f deploy/Dockerfile -t quietpay-backend .
# Run one service:                         docker run ... quietpay-backend relayer-facilitator
# Node and pnpm are pinned, dependencies come only from pnpm-lock.yaml (--frozen-lockfile).
FROM node:20.18.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.0.0
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY apps ./apps
COPY deploy ./deploy
RUN pnpm install --frozen-lockfile && chmod +x /app/deploy/start.sh
ENV NODE_ENV=production DATABASE_PATH=/data/quietpay.db PORT=8787 BACKUP_DIR=/data/backups
EXPOSE 8787 8788 8790 3001
ENTRYPOINT ["/app/deploy/start.sh"]
CMD ["relayer-facilitator"]
