FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/qwen-agent/package.json ./packages/qwen-agent/
RUN npm ci --workspaces=false
COPY packages/qwen-agent/ ./packages/qwen-agent/
RUN cd packages/qwen-agent && npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/packages/qwen-agent/dist ./packages/qwen-agent/dist
COPY --from=build /app/packages/qwen-agent/src ./packages/qwen-agent/src
COPY --from=build /app/packages/qwen-agent/package.json ./packages/qwen-agent/
COPY --from=build /app/node_modules ./node_modules
WORKDIR /app/packages/qwen-agent
RUN mkdir -p logs
USER node
CMD ["sh", "-c", "node --import tsx/esm src/cli.ts --symbol BTCUSDT --duration 10m"]
