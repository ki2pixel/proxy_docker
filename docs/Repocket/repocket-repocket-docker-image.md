# repocket/repocket

- **Author:** repocket
- **Last updated:** Updated almost 2 years ago
- **Image description:** Repocket Docker Image
- **Badges:** IMAGE, 23, 10M+

## Navigation

- Overview
- Tags

# Repocket Docker Image

This guide will teach you how to install and run Repocket Docker Image in a few easy steps.

## Installation

1. Create an account on [Repocket]().
2. Get your api key from the [Repocket dashboard]().
3. Install Docker.

   Docker is required to run Repocket, please follow the [original Docker instructions]() on how to set it up for your system.

4. Pull the Repocket Docker Image from Docker Hub with this command:

   ```shell
   docker pull repocket/repocket :
   ```

   Or you can pull from this mirror:

   ```shell
   docker pull rg.fr-par.scw.cloud/repocket-docker/repocket:latest
   ```

   ```shell
   docker tag rg.fr-par.scw.cloud/repocket-docker/repocket:latest repocket/repocket:latest
   ```

5. Create an `rp.env` file:

   ```shell
   touch rp.env
   ```

6. Use your favourite text editor to put your Repocket credentials into the `rp.env` file. Like this:

   ```dotenv
   RP_EMAIL=your@email.com
   RP_API_KEY=your_api_key
   ```

Now you have everything needed to run Repocket.

## Running

You have multiple options of running Repocket. First, we'll show you the safest and the most convenient one.

Simply execute the following command in a folder with your `rp.env` file.

```shell
docker run --env-file rp.envd-restart=always repocket/repocket
```

This will automatically handle launching Repocket on your system start, and restarting it if anything goes wrong.

Alternatively, if you don't want to create the `rp.env` file, you can use this command to specify the credentials right in your command line:

```shell
docker run --name repocket -e RP_EMAIL=your@email.com -e RP_API_KEY=your_api_key -d --restart=always repocket/repocket
```

## Tag summary

- latest
- Image
- sha256:5888d756d...
- 43.9 MB
- almost 2 years ago

```shell
docker pull repocket/repocket