FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts && npx playwright install --with-deps chromium && \
    apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk ffmpeg && \
    rm -rf /var/lib/apt/lists/* && chmod -R a+rX /opt/browsers
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/tests ./tests
COPY --from=build /app/tsconfig.json ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3100
CMD ["npm", "start"]
