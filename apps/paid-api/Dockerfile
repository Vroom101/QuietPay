FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm@10
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared ./packages/shared
COPY packages/merchant-sdk ./packages/merchant-sdk
COPY packages/relayer ./packages/relayer
COPY apps/paid-api ./apps/paid-api
RUN pnpm install --prod --frozen-lockfile --filter @quietpay/paid-api...
ENV NODE_ENV=production PAID_API_PORT=8790
EXPOSE 8790
CMD ["pnpm", "--filter", "@quietpay/paid-api", "start"]
