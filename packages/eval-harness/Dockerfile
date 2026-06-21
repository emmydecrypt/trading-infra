FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/eval-harness/package.json ./packages/eval-harness/
RUN npm ci --workspaces=false
COPY packages/eval-harness/ ./packages/eval-harness/
RUN cd packages/eval-harness && npm run build || true

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 py3-pip
COPY --from=build /app/packages/eval-harness/dist ./packages/eval-harness/dist 2>/dev/null || true
COPY --from=build /app/packages/eval-harness/src ./packages/eval-harness/src
COPY --from=build /app/packages/eval-harness/package.json ./packages/eval-harness/
COPY --from=build /app/packages/eval-harness/test ./packages/eval-harness/test
COPY --from=build /app/node_modules ./node_modules
WORKDIR /app/packages/eval-harness
RUN mkdir -p data
EXPOSE 4000
ENV EVAL_PORT=4000
ENV EVAL_DB_PATH=/app/data/eval.db
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["sh", "-c", "node --import tsx/esm src/server.ts"]
