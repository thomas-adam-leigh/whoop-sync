FROM node:22-slim

# Install Playwright system dependencies
RUN npx playwright install --with-deps chromium

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production=false

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build
RUN npm prune --production

CMD ["node", "dist/index.js"]
