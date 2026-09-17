FROM node:22-alpine
WORKDIR /app
COPY sync-worker.mjs ./sync-worker.mjs
USER node
CMD ["node", "sync-worker.mjs"]
