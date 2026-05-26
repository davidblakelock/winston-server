FROM node:22-alpine
RUN npm install -g pnpm
WORKDIR /app
COPY . .
WORKDIR /app/artifacts/api-server
RUN pnpm install
RUN pnpm run build
WORKDIR /app
EXPOSE 3000
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
