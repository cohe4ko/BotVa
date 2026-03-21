FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build
EXPOSE 3456
CMD ["node", "dist/server.js"]
