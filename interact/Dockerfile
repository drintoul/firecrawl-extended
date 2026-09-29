FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev \
    && npx playwright install --with-deps \
    && npm cache clean --force

COPY src ./src

ENV PORT=3001
EXPOSE 3001
CMD ["node", "src/server.js"]
