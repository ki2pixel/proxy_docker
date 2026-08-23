# EarnFM Client Docker Setup Guide

## EarnFM Client Docker Setup Guide

This guide explains how to run the EarnFM client with Docker. The official image is
**`earnfm/earnfm-client:latest`** (12.4 MB — by earnfm, updated regularly).

### Prerequisites

* **Docker:** Docker should be installed on your machine. If not, follow the installation guide here: [Install Docker](https://docs.docker.com/get-docker/).
* **Earn.fm account & API Key:** If you are not already registered, make an account at [https://app.earn.fm](https://app.earn.fm) and copy your API Key from your settings.

### Setup (standalone)

```bash
sudo docker run -d --restart=always -e EARNFM_TOKEN="YOUR_APIKEY_PLEASE_REPLACE_ME" --name earnfm-client earnfm/earnfm-client:latest
```

Replace `"YOUR_APIKEY_PLEASE_REPLACE_ME"` with your actual EarnFM token
(examples of format: `97f7414b-a0fb-4862-baba-e988d9a127fb`).

### Intégration dans proxy_docker

Dans la stack multi-passerelles, EarnFM est géré comme un provider standard
(profile compose `gw{n}-earnfm`, service `earnfm-{n}`, `network_mode: service:gateway-isp-{n}`) :

* **Variable** : `GW{n}_EARNFM_TOKEN` dans `.env` (une par passerelle — un token par device/IP).
* **Activation** : `COMPOSE_PROFILES="earnfm"` (ou `all`, ou `earnfm,honeygain,...`) puis `./scripts/start.sh`.
* **Mise à jour** : image `:latest` recréée par le CI (`up -d --build --force-recreate`) — aucun Watchtower nécessaire.
* **Dashboard** : état et contrôle start/stop/restart du conteneur via le dashboard (`EarnFM`, lien vers https://app.earn.fm).

### Enjoy earning at scale
