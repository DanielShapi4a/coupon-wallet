# One image, two roles (architecture.md): the default command runs the API,
# and the daily worker runs the same image with `node src/index.ts worker`.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --workspace @cw/server

COPY packages/shared/src packages/shared/src
COPY apps/server/src apps/server/src
COPY apps/server/migrations apps/server/migrations

WORKDIR /app/apps/server
USER node
EXPOSE 3000
CMD ["node", "src/index.ts", "api"]
