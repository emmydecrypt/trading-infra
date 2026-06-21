FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/mcp-server/package.json ./packages/mcp-server/
RUN npm ci --workspaces=false
COPY packages/mcp-server/ ./packages/mcp-server/
RUN cd packages/mcp-server && npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/packages/mcp-server/dist ./packages/mcp-server/dist
COPY --from=build /app/packages/mcp-server/package.json ./packages/mcp-server/
COPY --from=build /app/node_modules ./node_modules
WORKDIR /app/packages/mcp-server
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
