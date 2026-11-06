# Build context is the repository root:  docker build -f packages/relayer/Dockerfile .
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm@10
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared ./packages/shared
COPY packages/relayer ./packages/relayer
RUN pnpm install --frozen-lockfile --filter @quietpay/relayer...
ENV NODE_ENV=production DATABASE_PATH=/data/quietpay.db PORT=8787
EXPOSE 8787
CMD ["pnpm", "--filter", "@quietpay/relayer", "start"]
