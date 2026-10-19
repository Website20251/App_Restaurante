FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000 RESTAURANTE_DATA=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["node", "server.js"]
