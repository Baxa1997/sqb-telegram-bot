# The Telegram bot server: Node 22 runs the TypeScript source directly.
FROM node:22.23.1-alpine
WORKDIR /usr/src/app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean
COPY src ./src
ENV NODE_ENV=production
# Vault writes the settings to /app/.env when the pod starts (as the cabinet's)
CMD ["node", "--experimental-strip-types", "--env-file-if-exists=/app/.env", "src/index.ts"]
