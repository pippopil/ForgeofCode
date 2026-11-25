FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates python3 python3-venv build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

RUN mkdir -p /app/data /app/work && chown -R node:node /app
USER node

EXPOSE 3000
CMD ["npx", "tsx", "server.ts"]
