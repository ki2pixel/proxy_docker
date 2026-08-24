---
publisher: "docker.com"
title: "pinors/antgain-cli - Docker Image"
lang: "en"
description: "Explore images from pinors/antgain-cli on Docker Hub. No description provided."
url: "https://hub.docker.com/r/pinors/antgain-cli"
author: "pinors"
word_count: 1283
reading_time: "5 min read"
---

## Table of Contents

- [What can I help you with?](#what-can-i-help-you-with)
- [pinors/antgain-cli](#pinorsantgain-cli)
- [pinors/antgain-cli repository overview](#pinorsantgain-cli-repository-overview)
  - [AntGain CLI — Docker](#antgain-cli--docker)
    - [Image tags](#image-tags)
    - [Device UUID (read this first)](#device-uuid-read-this-first)
    - [Quick start](#quick-start)
    - [Required environment variables](#required-environment-variables)
    - [Optional environment variables](#optional-environment-variables)
    - [Docker Compose](#docker-compose)
    - [Multiple nodes on one host](#multiple-nodes-on-one-host)
    - [Logs](#logs)
    - [CLI commands inside the container](#cli-commands-inside-the-container)
    - [Upgrade (keep the same device id)](#upgrade-keep-the-same-device-id)
    - [Platform support](#platform-support)
    - [Troubleshooting](#troubleshooting)
    - [Bare-metal install (Linux / macOS)](#bare-metal-install-linux--macos)
    - [Links](#links)
  - [Tag summary](#tag-summary)
        - [Why](#why)
        - [Products](#products)
        - [Product Offerings](#product-offerings)
        - [Features](#features)
        - [Developers](#developers)
        - [Company](#company)
        - [Why](#why-1)
        - [Products](#products-1)
        - [Product Offerings](#product-offerings-1)
        - [Features](#features-1)
        - [Developers](#developers-1)
        - [Company](#company-1)

---

#### What can I help you with?

I'm Gordon, your AI teammate for Docker and development questions. I can help with this image and how to use it.

How can I help?

**Try asking**

Answers are generated based on the documentation and your assets.

Help

System theme

Docker Suite

[Sign in](https://hub.docker.com/login) [Sign up](https://app.docker.com/signup)

1.  [Explore](https://hub.docker.com/search)

2.  [pinors](https://hub.docker.com/u/pinors)

3.  antgain-cli

## pinors/antgain-cli

By [pinors](https://hub.docker.com/u/pinors)

•Updated 2 months ago

Image

**0**

100K+

[Overview](https://hub.docker.com/r/pinors/antgain-cli) [Tags](https://hub.docker.com/r/pinors/antgain-cli/tags)

## pinors/antgain-cli repository overview

### AntGain CLI — Docker

Run an AntGain node in a container. Each container needs its own API key and a **stable UUID** (`ANTGAIN_DEVICE_ID`) so recreating the container keeps the same device identity on the server.

**API key:** [antgain.app → Settings⁠](https://antgain.app/dashboard/settings)

------------------------------------------------------------------------

#### Image tags

| Tag                            | Description                                     |
| ------------------------------ | ----------------------------------------------- |
| `pinors/antgain-cli:latest`    | Latest release (multi-arch)                     |
| `pinors/antgain-cli:<version>` | Pinned release, e.g. `pinors/antgain-cli:1.1.0` |

Docker pulls the manifest for your host CPU (`linux/amd64`, `linux/arm64`, `linux/arm/v7`).

------------------------------------------------------------------------

#### Device UUID (read this first)

`ANTGAIN_DEVICE_ID` binds your node on the server. **Generate a UUID once**, save it (`.env` / Compose), and **reuse the same value** when you recreate the container.

**Do not** use `-e ANTGAIN_DEVICE_ID=$(uuidgen ...)` on every `docker run` — each new UUID is treated as a **new device**.

If the container already has `~/.antgain/config.json` with a saved id, **`ANTGAIN_DEVICE_ID` in the environment still wins**. Pass a **fixed** env UUID that matches the node you intend to keep.

------------------------------------------------------------------------

#### Quick start

**First time** — create `.env` with a new UUID (generate once):

```bash
uuidgen | tr '[:upper:]' '[:lower:]'
# Add to .env:
# ANTGAIN_API_KEY=your_api_key_here
# ANTGAIN_DEVICE_ID=f6fdbd41-4e2c-4a1b-9c3d-8e7f6a5b4c2d
```

```bash
docker run -d \
  --name antgain-node \
  --restart unless-stopped \
  --env-file .env \
  pinors/antgain-cli:latest
```

Check the container:

```bash
docker ps --filter name=antgain-node
docker logs -f antgain-node
```

Inside the container, view the **audit log file** (English, redacted, `antgain.log`):

```bash
docker exec -it antgain-node antgain logs -f
```

------------------------------------------------------------------------

#### Required environment variables

| Variable            | Required | Description                                                                                                                                                                              |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTGAIN_API_KEY`   | Yes      | Your AntGain API key.                                                                                                                                                                    |
| `ANTGAIN_DEVICE_ID` | Yes      | Standard UUID for **this** container — **hardcode** in `.env`; never `uuidgen` on each start. Same value when you recreate **the same** node; different UUID per simultaneous container. |

Generate a UUID **once** when creating a new node, then store it in `.env` or Compose. No volume is required if you always pass the same env UUID.

------------------------------------------------------------------------

#### Optional environment variables

| Variable                           | Default | Description                                                                            |
| ---------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| `ANTGAIN_AUTO_UPDATE_ON_RECONNECT` | on      | Set to `0` or `false` to disable in-container update check on QUIC reconnect           |
| `ANTGAIN_SKIP_UPDATE_ON_RECONNECT` | off     | Set to `1` to disable reconnect updates (same as `ANTGAIN_AUTO_UPDATE_ON_RECONNECT=0`) |

Audit logging is **INFO-only** in a single file (`antgain.log`). `LOG_LEVEL` / `RUST_LOG` do not change it. Secrets are redacted in the file.

When the backend returns an observed public IP in the active-report API `data` field, audit lines may include `public_ip=...`; until then only `host_ip` is shown.

------------------------------------------------------------------------

#### Docker Compose

`docker-compose.yml`:

```yaml
services:
  antgain-node:
    image: pinors/antgain-cli:latest
    container_name: antgain-node
    restart: unless-stopped
    environment:
      ANTGAIN_API_KEY: ${ANTGAIN_API_KEY}
      ANTGAIN_DEVICE_ID: ${ANTGAIN_DEVICE_ID}
```

```bash
export ANTGAIN_API_KEY=your_api_key_here
export ANTGAIN_DEVICE_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
docker compose up -d
docker compose logs -f antgain-node
```

------------------------------------------------------------------------

#### Multiple nodes on one host

Each service must use a **unique** `ANTGAIN_DEVICE_ID`:

```yaml
services:
  antgain-node-1:
    image: pinors/antgain-cli:latest
    container_name: antgain-node-1
    restart: unless-stopped
    environment:
      ANTGAIN_API_KEY: ${ANTGAIN_API_KEY}
      ANTGAIN_DEVICE_ID: f6fdbd41-4e2c-4a1b-9c3d-8e7f6a5b4c2d

  antgain-node-2:
    image: pinors/antgain-cli:latest
    container_name: antgain-node-2
    restart: unless-stopped
    environment:
      ANTGAIN_API_KEY: ${ANTGAIN_API_KEY}
      ANTGAIN_DEVICE_ID: 7b718a26-b719-4cbe-a42a-bf1eb563fb14
```

------------------------------------------------------------------------

#### Logs

| What you need               | Command                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| Container stdout/stderr     | `docker logs -f antgain-node`                                           |
| Audit file inside container | `docker exec -it antgain-node antgain logs -f`                          |
| Last N lines                | `docker exec -it antgain-node antgain logs -n 200`                      |
| Custom path                 | `docker exec -it antgain-node antgain logs --file /path/to/antgain.log` |

Default audit path in the image: `/home/antgain/.antgain/logs/antgain.log`.

------------------------------------------------------------------------

#### CLI commands inside the container

```bash
docker exec -it antgain-node antgain status
docker exec -it antgain-node antgain info
docker exec -it antgain-node antgain logs -f
```

------------------------------------------------------------------------

#### Upgrade (keep the same device id)

Reuse the **same** `.env` / `ANTGAIN_DEVICE_ID` — do not run `uuidgen` again.

```bash
docker pull pinors/antgain-cli:latest
docker stop antgain-node
docker rm antgain-node
docker compose up -d    # or docker run --env-file .env ...
```

Or use `docker exec antgain-node antgain update` before replacing the container (image must include a newer binary on CDN).

------------------------------------------------------------------------

#### Platform support

| Platform       | Architecture     |
| -------------- | ---------------- |
| `linux/amd64`  | x86_64           |
| `linux/arm64`  | ARM64 / ARMv8    |
| `linux/arm/v7` | ARMv7 hard-float |

Static musl binaries — no host glibc version requirement.

Use image **1.1.0+** for `ANTGAIN_DEVICE_ID` / `deviceId` registration. When upgrading, keep the same `ANTGAIN_DEVICE_ID` for the same logical node.

------------------------------------------------------------------------

#### Troubleshooting

**Node does not connect after recreate**\
You used a **new** `ANTGAIN_DEVICE_ID` (e.g. `uuidgen` in the run line) instead of the original UUID. Restore the same UUID from your `.env` or dashboard device list.

**Missing `ANTGAIN_DEVICE_ID`**\
Docker nodes require a standard UUID; the process will not start without it.

**Device identity conflict**\
Two running containers share the same `ANTGAIN_DEVICE_ID`. Stop one or assign a new UUID.

**View audit log**\
`docker exec -it antgain-node antgain logs -f`

------------------------------------------------------------------------

#### Bare-metal install (Linux / macOS)

User install guides: [install.antgain.app⁠](https://install.antgain.app/) (see `antgain-installer` documentation).

------------------------------------------------------------------------

#### Links

| Resource     | URL                                                                                 |
| ------------ | ----------------------------------------------------------------------------------- |
| Website      | [https://antgain.app⁠ ✓](https://antgain.app/)                                      |
| API key      | [https://antgain.app/dashboard/settings⁠ ✓](https://antgain.app/dashboard/settings) |
| Docs         | [https://docs.antgain.app⁠ ✓](https://docs.antgain.app/)                            |
| Docker image | <https://hub.docker.com/r/pinors/antgain-cli>                                       |

### Tag summary

Recent tags

latest

**Content type**

Image

**Digest**

sha256:4a7b8806d…

**Size**

45.4 MB

**Last updated**

2 months ago

```bash
docker pull pinors/antgain-cli
```

###### Why

[Overview](https://www.docker.com/why-docker) [What is a Container](https://www.docker.com/resources/what-container)

###### Products

[Product Overview](https://www.docker.com/products)

###### Product Offerings

[Docker Desktop](https://www.docker.com/products/docker-desktop) [Docker Hub](https://www.docker.com/products/docker-hub)

###### Features

[Container Runtime](https://www.docker.com/products/container-runtime) [Developer Tools](https://www.docker.com/products/developer-tools) [Docker App](https://www.docker.com/products/docker-app) [Kubernetes](https://www.docker.com/products/kubernetes)

###### Developers

[Getting Started](https://docs.docker.com/get-started) [Play with Docker](https://www.docker.com/play-with-docker) [Community](https://www.docker.com/docker-community) [Open Source](https://www.docker.com/open-source) [Documentation](https://www.docker.com/docs)

###### Company

[About Us](https://www.docker.com/company) [Resources](https://www.docker.com/resources) [Blog](https://www.docker.com/blog/) [Customers](https://www.docker.com/customers) [Partners](https://www.docker.com/partners) [Newsroom](https://www.docker.com/company/newsroom) [Events and Webinars](https://www.docker.com/events-and-webinars) [Careers](https://www.docker.com/careers) [Contact Us](https://www.docker.com/company/contact) [System Status⁠](https://www.dockerstatus.com/)

------------------------------------------------------------------------

© 2026 Docker, Inc. All rights reserved. \| [Terms of Service](https://www.docker.com/legal/docker-terms-service) \| [Subscription Service Agreement](https://www.docker.com/legal/docker-subscription-service-agreement) \| [Privacy](https://www.docker.com/legal/privacy) \| [Legal](https://www.docker.com/legal)

###### Why

[Overview](https://www.docker.com/why-docker)[What is a Container](https://www.docker.com/resources/what-container)

###### Products

[Product Overview](https://www.docker.com/products)

###### Product Offerings

[Docker Desktop](https://www.docker.com/products/docker-desktop)[Docker Hub](https://www.docker.com/products/docker-hub)

###### Features

[Container Runtime](https://www.docker.com/products/container-runtime)[Developer Tools](https://www.docker.com/products/developer-tools)[Docker App](https://www.docker.com/products/docker-app)[Kubernetes](https://www.docker.com/products/kubernetes)

###### Developers

[Getting Started](https://docs.docker.com/get-started)[Play with Docker](https://www.docker.com/play-with-docker)[Community](https://www.docker.com/docker-community)[Open Source](https://www.docker.com/open-source)[Documentation](https://www.docker.com/docs)

###### Company

[About Us](https://www.docker.com/company)[Resources](https://www.docker.com/resources)[Blog](https://www.docker.com/blog/)[Customers](https://www.docker.com/customers)[Partners](https://www.docker.com/partners)[Newsroom](https://www.docker.com/company/newsroom)[Events and Webinars](https://www.docker.com/events-and-webinars)[Careers](https://www.docker.com/careers)[Contact Us](https://www.docker.com/company/contact)[System Status⁠](https://www.dockerstatus.com/)

------------------------------------------------------------------------

© 2026 Docker, Inc. All rights reserved. \| [Terms of Service](https://www.docker.com/legal/docker-terms-service) \| [Subscription Service Agreement](https://www.docker.com/legal/docker-subscription-service-agreement) \| [Privacy](https://www.docker.com/legal/privacy) \| [Legal](https://www.docker.com/legal)

[Visit our Facebook page](https://www.facebook.com/docker.run)[Visit our X page](https://x.com/docker)[Visit our YouTube page](https://www.youtube.com/user/dockerrun)[Visit our LinkedIn page](https://www.linkedin.com/company/docker)[View our RSS feed](https://www.docker.com/feed/)