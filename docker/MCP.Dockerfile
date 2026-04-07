FROM oven/bun:1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY .npmrc ./
COPY package.json ./
COPY bun.lock ./
RUN bun install --frozen-lockfile

COPY mcp ./mcp

CMD ["node", "./mcp/server.mjs", "--docker"]