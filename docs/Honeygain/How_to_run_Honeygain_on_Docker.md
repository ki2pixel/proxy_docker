# How to run Honeygain on Docker

*User profile • 6 months ago • Updated*

---

Docker is software that is used to run software in an isolated environment called a **container**. Docker is multiplatform and can be run on Windows, macOS, and Linux. 

> **Note:** Currently, only x86/x64 architecture processors are supported. If you are not familiar with Docker, we recommend checking out their [official website](https://www.docker.com/) and documentation for further information.

It is fairly easy to set up and run Honeygain on Docker. Below are the steps and several tricks to enhance your Honeygain experience.

## Installing Docker
Docker can be downloaded and installed from their official website. Select your operating system and follow the provided instructions to complete the setup.

## Running Honeygain Docker Image
After installing Docker, you need to pull the image and run the container using the following commands:

```bash
docker pull honeygain/honeygain
docker run honeygain/honeygain -tou-get
docker run honeygain/honeygain -tou-accept -email ACCOUNT_EMAIL -pass ACCOUNT_PASSWORD -dev DEVICE_NAME
```

**Important:**
* Replace `ACCOUNT_EMAIL`, `ACCOUNT_PASSWORD`, and `DEVICE_NAME` with your actual credentials and desired device identifier.
* Use a **unique** `DEVICE_NAME` for each container you run.

## Enabling Auto-Start on System Restart
To ensure Honeygain starts automatically if your system reboots, use the `--restart` flag:

```bash
docker run --restart unless-stopped honeygain/honeygain -tou-accept -email ACCOUNT_EMAIL -pass ACCOUNT_PASSWORD -dev DEVICE_NAME
```

If you need to update an existing container to auto-start:
```bash
docker ps -a # to find your CONTAINER_ID
docker update --restart unless-stopped CONTAINER_ID
docker ps # to list active containers
```

## Running Docker Container in the Background
To run the container in "detached" mode (so it doesn't close when you close your terminal), add the `-d` flag:

```bash
docker run -d honeygain/honeygain -tou-accept -email ACCOUNT_EMAIL -pass ACCOUNT_PASSWORD -dev DEVICE_NAME
```

To move an existing container to the background:
```bash
docker run -d CONTAINER_ID
```

## Background + Auto-Start Mode
For the most efficient setup (running in the background and starting automatically on boot), combine the flags:

```bash
docker run -d --restart unless-stopped honeygain/honeygain -tou-accept -email ACCOUNT_EMAIL -pass ACCOUNT_PASSWORD -dev DEVICE_NAME
```

## Permission Denied Error
If you encounter an error stating *"Got permission denied while trying to connect to the Docker daemon socket..."*, you likely need administrative privileges. Try prefixing your commands with `sudo`:

```bash
sudo docker [command]
```

## Content Delivery Support
**Content Delivery** is currently **not available** on Docker containers. This feature may be introduced in future updates.

## Docker on ARM Architecture
Starting from Honeygain version **0.8.1**, Honeygain supports ARM-based devices such as the **Raspberry Pi**. You can run Honeygain on these devices just like you would on a regular desktop environment.

---

If you experience any issues setting up Honeygain on Docker, please contact us using our support form.