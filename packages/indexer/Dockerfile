# Build context: repository root.
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm@10
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared ./packages/shared
COPY packages/indexer ./packages/indexer
RUN pnpm install --frozen-lockfile --filter @quietpay/indexer...
ENV NODE_ENV=production INDEXER_DATABASE_PATH=/data/indexer.db INDEXER_PORT=8788
EXPOSE 8788
CMD ["pnpm", "--filter", "@quietpay/indexer", "start"]
