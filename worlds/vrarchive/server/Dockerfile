FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
ENV PORT=7777
EXPOSE 7777
CMD ["node", "server.js"]
