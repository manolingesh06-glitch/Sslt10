# Simple single-stage build — this app is plain Node + Express + Socket.IO,
# no build step needed.
FROM node:20-slim

# better-sqlite3 needs build tools to compile its native binding on install.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Persisted across restarts if you mount a volume/disk here (see render.yaml).
# data/       -> SQLite DB (admin accounts, auction configs)
# uploads/    -> uploaded sound files
RUN mkdir -p data uploads/sounds

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

# Matches the /health route already in src/server.js
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||4000)+'/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

CMD ["node", "src/server.js"]
