FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public

ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/index.js"]
