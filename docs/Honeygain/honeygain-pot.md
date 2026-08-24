---
publisher: "docker.com"
title: "xterna/honeygain-pot - Docker Image"
lang: "en"
description: "Containerized Docker image for Honeygain Pot 🍯🐝."
url: "https://hub.docker.com/r/xterna/honeygain-pot"
author: "xterna"
word_count: 992
reading_time: "4 min read"
---

## Table of Contents

- [What can I help you with?](#what-can-i-help-you-with)
- [xterna/honeygain-pot](#xternahoneygain-pot)
- [xterna/honeygain-pot repository overview](#xternahoneygain-pot-repository-overview)
  - [Honeygain Pot 🐝🍯](#honeygain-pot-%F0%9F%90%9D%F0%9F%8D%AF)
      - [Containerized Docker image for Honeygain⁠ lucky pot 🍯](#containerized-docker-image-for-honeygain%E2%81%A0-lucky-pot-%F0%9F%8D%AF)
    - [Pulling Image 🐳](#pulling-image-%F0%9F%90%B3)
    - [Overview 🐝](#overview-%F0%9F%90%9D)
      - [Image Variants 📦](#image-variants-%F0%9F%93%A6)
    - [Features 🚀](#features-%F0%9F%9A%80)
      - [Output 🖥️](#output-%F0%9F%96%A5%EF%B8%8F)
    - [Usage 📃](#usage-%F0%9F%93%83)
    - [Docker Deployment 🐳](#docker-deployment-%F0%9F%90%B3)
      - [Compose](#compose)
      - [CLI](#cli)
    - [Like My Work? 🫶](#like-my-work-%F0%9F%AB%B6)
    - [Disclaimer ⚠️](#disclaimer-%E2%9A%A0%EF%B8%8F)
  - [Tag Summary](#tag-summary)
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

2.  [xterna](https://hub.docker.com/u/xterna)

3.  honeygain-pot

## xterna/honeygain-pot

By [xterna](https://hub.docker.com/u/xterna)

•Updated almost 2 years ago

Containerized Docker image for Honeygain Pot 🍯🐝.

Internet of things

**2**

786

[Overview](https://hub.docker.com/r/xterna/honeygain-pot) [Tags](https://hub.docker.com/r/xterna/honeygain-pot/tags)

## xterna/honeygain-pot repository overview

### Honeygain Pot 🐝🍯

[![Static Badge](https://img.shields.io/badge/GitHub-blue?style=flat&logo=github)](https://github.com/XternA/honeygain-reward) ![GitHub package.json dynamic](https://img.shields.io/github/package-json/version/XternA/honeygain-reward?style=flat&logo=opencontainersinitiative&label=Image%20Tag&color=red) [![Docker Stars](https://img.shields.io/docker/stars/xterna/honeygain-pot?logo=docker&label=Docker%20Stars)](https://hub.docker.com/r/xterna/honeygain-pot) [![GitHub Repo stars](https://img.shields.io/github/stars/XternA/honeygain-reward?style=flat&logo=github&label=Stars&color=orange)](https://github.com/XternA/honeygain-reward) [![Donate](https://img.shields.io/badge/Donate-PayPal-blue.svg?style=flat&logo=paypal)](https://www.paypal.com/donate/?hosted_button_id=32DCQ65QM5FNE)

If you like this project, don't forget to leave a star. ⭐

##### Containerized Docker image for Honeygain⁠ lucky pot 🍯

> **Note:** This built image comes with no warranty of any kind. By using this image you agree this License Agreement in addition with Honeygain's T&C.

This is a simple Docker image for running Honeygain's lucky pot auto-claim bot.

#### Pulling Image 🐳

**64-Bit Platform:** `linux/amd64` `linux/arm64`

```sh
docker pull ghcr.io/xterna/honeygain-pot
```

**32-Bit Platform:** `linux/arm/v7`

```sh
docker pull ghcr.io/xterna/honeygain-pot:arm32v7
```

#### Overview 🐝

[**Honeygain-Pot** ⁠](https://bit.ly/3x6nX1S) 🍯 is a very lightweight bot powered by Bun JavaScript runtime to automatically claim your lucky pot bonus daily from [**Honeygain** ⁠](https://bit.ly/3x6nX1S) 🐝.

The bot is designed to be run in a docker environment, allowing it to be deployed alongside the Honeygain docker container.

Very minimal resources, resulting in CPU utilisation staying at idle **0%** the entire time.

```bash
NAME            CPU %     MEM USAGE / LIMIT   MEM %     NET I/O         BLOCK I/O
honeygain-pot   0.00%     592KiB / 320MiB     0.17%     3.3MB / 206kB   0B / 43.6MB
```

##### Image Variants 📦

| Variant                  | Image Size | Platforms           |
| ------------------------ | ---------- | ------------------- |
| Honeygain Pot (IGM)      | 3.98MB     | amd64, arm64, armv7 |
| Honeygain Pot (Standard) | 153MB      | amd64, arm64        |
| Honeygain Pot (arm32v7)  | 209MB      | armv7               |

The super-lightweight optimised version is licensed exclusively for use with Income Generator (IGM).

[**Income Generator** ⁠](https://github.com/XternA/income-generator) (IGM) comes pre-configured with a significantly faster, super-lightweight version, including automatic updates. It orchestrates multiple passive income sources with proxy support to maximise earnings and is highly recommended for use.

#### Features 🚀

- Automatically log in and claim daily lucky pot.
- Caching to avoid unnecessary logins for faster execution.
- Find out the remaining time before the next claim.
- Set up the timer and auto-wait for the duration.
- On ready to reclaim, repeat the cycle.
- If an error occurs, will cool down and re-attempt.
- Works with `Honeygain` and `JumpTask` mode.

##### Output 🖥️

This is what the script looks like when you inspect the output.

```bash
------------ Honeygain Pot Auto Claim ------------
Logging in as bee@honeypot.com
Logged into Honeygain 🐝
--------------------------------------------------

Active Devices: 5 💻

Earning with JumpTask wallet 💰
Claimed 100 credits ✅
Won today 10 credits 🤑
Gathered 2.53 GB today 💻
Earned today 157.43 credits 🍯
JumpTask bonus 7.58 🍯

Waiting for next available pot to claim 🍯
Ready to claim in 7 hours 40 minutes ⏱️

Current logged time: 16:19:26
Next event trigger:  00:00:00

Ready to claim again ✅
```

#### Usage 📃

Define the following environment variable to bootstrap the image.

| Variable     | Description                  | Mandatory |
| ------------ | ---------------------------- | --------- |
| **EMAIL**    | Your Honeygain email address | YES       |
| **PASSWORD** | Your Honeygain password      | YES       |

Or supply credentials in a Dotenv `.env` file.

```markdown
EMAIL=<email_address>
PASSWORD=<password_credential>
```

#### Docker Deployment 🐳

##### Compose

File: `compose.yml`

```yaml
services:
  honeygain-pot:
    container_name: honeygain-pot
    image: ghcr.io/xterna/honeygain-pot
    restart: unless-stopped
    environment:
      - EMAIL=$EMAIL
      - PASSWORD=$PASSWORD
    dns:
      - 1.1.1.1
      - 8.8.8.8
```

With Honeygain app docker image.

```yaml
services:
  honeygain:
    container_name: honeygain
    image: honeygain/honeygain
    restart: always
    command: -tou-accept -email $EMAIL -pass $PASSWORD -device $<name_to_identify_device>
    dns:
      - 1.1.1.1
      - 8.8.8.8

  honeygain-pot:
    container_name: honeygain-pot
    image: xterna/honeygain-pot
    restart: unless-stopped
    environment:
      - EMAIL=$EMAIL
      - PASSWORD=$PASSWORD
    dns:
      - 1.1.1.1
      - 8.8.8.8
    depends_on:
      - honeygain
```

Execute where compose file is located.

```yaml
docker compose up -d
```

##### CLI

Using environment variable or Dotenv `.env` defined e.g.

```sh
docker run -d --restart unless-stopped --name honeygain-pot -e EMAIL=$HONEYGAIN_EMAIL -e PASSWORD=$HONEYGAIN_PASSWORD ghcr.io/xterna/honeygain-pot
```

Directly passing credentials.

```sh
docker run -d --restart unless-stopped --name honeygain-pot -e EMAIL=example.gmail.com -e PASSWORD=pass123 ghcr.io/xterna/honeygain-pot
```

This will start the application in the background. The alias assigned is `honeygain-pot`.

#### Like My Work? 🫶

Donations are warmly welcomed no matter how small and thank you very much. 😌

- **Bitcoin (BTC)** - `bc1qq993w3mxsf5aph5c362wjv3zaegk37tcvw7rl4`
- **Ethereum (ETH)** - `0x2601B9940F9594810DEDC44015491f0f9D6Dd1cA`
- **Binance Smart Chain (BSC)** - `0x2601B9940F9594810DEDC44015491f0f9D6Dd1cA`
- **Solana (SOL)** - `Ap5aiAbnsLtR2XVJB3sp37qdNP5VfqydAgUThvdEiL5i`
- **PayPal** - [@xterna⁠](https://paypal.me/xterna)

#### Disclaimer ⚠️

Disclaimer: This image is neither affiliated with nor endorsed by Honeygain. Use this image at your own risk and responsibility. By using this image, you agree to be automatically bound by the License Agreement associated with it.

The author does not provide any assurances, whether explicit or implicit, regarding the accuracy, completeness, or appropriateness of this image for specific purposes. The author shall not be held accountable for any damages, including but not limited to direct, indirect, incidental, consequential, or special damages, arising from the use or inability to use this image or its accompanying documentation, even if the possibility of such damages has been communicated.

By choosing to use this image, you acknowledge and assume all risks associated with its use. Additionally, you agree that the author cannot be held liable for any issues or consequences that may arise as a result of its usage.

### Tag Summary

No tags have been pushed to this repository yet.

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