FROM node:20-alpine

WORKDIR /app

# curl pour le healthcheck ; pas de docker-cli (l'orchestration passe par l'API socket)
RUN apk add --no-cache curl wget

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Non-root
RUN chown -R node:node /app
USER node

EXPOSE 8080

CMD ["node", "index.js"]
