FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts/copy-ui-assets.mjs ./scripts/copy-ui-assets.mjs
RUN npm run build

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
COPY infra/migrations ./infra/migrations
USER node
EXPOSE 8080
CMD ["node", "dist/apps/mcp-server/src/main-provider.js"]
