FROM node:22-alpine

RUN npm install -g pnpm@9.15.9

WORKDIR /app

COPY . .

RUN pnpm install --no-frozen-lockfile && pnpm --filter @workspace/api-server run build

ENV NODE_ENV=production

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
