FROM node:22-bookworm-slim AS build
ARG ENABLE_HSTS=false
ENV ENABLE_HSTS=${ENABLE_HSTS}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ARG ENABLE_HSTS=false
ENV NODE_ENV=production ENABLE_HSTS=${ENABLE_HSTS}
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/next.config.mjs ./next.config.mjs
COPY --from=build --chown=node:node /app/drizzle ./drizzle
USER node
EXPOSE 3000 4000
CMD ["node", "build/server/api.js"]
