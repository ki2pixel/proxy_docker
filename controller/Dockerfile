FROM node:20-alpine

WORKDIR /app

# Outils réseau, docker-cli et docker-compose pour le pilotage de la stack
RUN apk add --no-cache curl wget docker-cli docker-cli-compose

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Les assets versionnés (public/dist) sont générés AVANT le build par
# scripts/build-assets.mjs (voir .github/workflows/deploy.yml et start.sh)
COPY . .

EXPOSE 8080

CMD ["node", "index.js"]

