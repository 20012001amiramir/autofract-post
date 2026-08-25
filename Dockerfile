# Zero-dependency Node app — no npm install step, so the Coolify build cannot fail on registry/native builds.
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server.js"]
