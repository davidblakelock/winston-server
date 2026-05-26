FROM node:22-alpine
RUN npm install -g pnpm
WORKDIR /app
COPY . .
RUN cd artifacts/api-server && pnpm install && pnpm run build
EXPOSE 3000
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
