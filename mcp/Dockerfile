FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src

ENV PORT=8081
EXPOSE 8081
CMD ["node", "src/index.js"]
