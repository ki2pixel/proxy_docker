# How to Install and Run Container in Docker

**Michelle Lee**  
*Last updated: May 27, 2025*

Many of our users have asked us to put together an accurate tutorial on how to use Pawns.app with Docker. When our marketing manager brought it up, I found the idea intriguing. I have an old PC that's doing absolutely nothing, and trying to make sense of Linux always sounds like a fun ride. And just like that, it was settled. I'd try it out, write this text to help the community, and hopefully learn something. 

I've been thinking about putting together a Pi-hole for a while and using containers for some stuff. A "contained" version of Pawns.app sounds like the perfect way to get into it, so let's begin!

---

## What Do We Need?

First of all, you need a device that can run Docker (which is available for many different platforms). 

*   **Hardware:** We'll be using an old PC with an i7 2600 from 2011. While it may not impress anyone nowadays, it's still more than capable enough for a task like this and moderate everyday use. You could also use a Raspberry Pi or a similar tiny computer.
*   **Operating System:** We'll go with the latest version of Ubuntu, just to play it safe. There's no particular reason behind this decision – it's just the distribution I'm most familiar with. It's probably worth noting that my Linux experience doesn't go too far beyond using a live USB once every couple of years. Theoretically, any Linux OS will work.
*   **Pawns.app Account:** You need a Pawns.app account. If you don't have one, check if some of your friends are already members of our community. If they are, ask them for their referral link and use it to sign up. That way, you both get a **$3 bonus!**

---

## Installing Docker

Right after you fire up your PC with Ubuntu, it's time to install and update Docker from it.

```bash
sudo apt-get update
sudo apt-get install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

Next, you need to add the repository to Apt sources:

```bash
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
```

Finally, it's time to install Docker. We'll go with the latest versions:

```bash
sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

### Verifying the Installation

All that's left to do is to ensure we installed it correctly. The easiest way to do this is by running the `hello-world` image. The following command downloads the test image and runs it in a container:

```bash
sudo docker run hello-world
```

The `hello-world` output means:
1.  The Docker client contacted the Docker daemon.
2.  The Docker daemon pulled the "hello-world" image from the Docker Hub (amd64).
3.  The Docker daemon created a new container from that image which runs the executable that produces the output you are currently reading.
4.  The Docker daemon streamed that output to the Docker client, which sent it to your terminal.

To try something more ambitious, you can run an Ubuntu container with:
`$ docker run -it ubuntu bash`

```text
pawnstest@Ubuntu01:~$ 
```

If you see this, you did everything correctly. Docker is installed and your test container works. Congratulations!

---

## Configuring the Pawns.app Container

With Docker ready to go, it's time to set up the Pawns.app container image. Our goal here is to do two things:
*   Get it up and running
*   Ensure it starts automatically on each reboot

We'll start by downloading the container itself.

```bash
sudo docker pull iproyal/pawns-cli:latest
```

**Output:**
```text
pawnstest@Ubuntu01: $ sudo docker pull iproyal/pawns-cli:latest
latest: Pulling from iproyal/pawns-cli
452f3f163c39: Pull complete
7e6415fbc95d: Pull complete
Digest: sha256:0409cc5aa1726bdd8680cfe7d8a02822a16f34685794821a08e151121d5a7d66
Status: Downloaded newer image for iproyal/pawns-cli:latest
docker.io/iproyal/pawns-cli:latest
pawnstest@Ubuntu01:-$
```

Now, we can run the downloaded image by using the following command. Make sure to change `your@email.com` and `yourpassword` with your Pawns.app credentials.

```bash
sudo docker run -d --restart=unless-stopped iproyal/pawns-cli:latest -email=your@email.com -password=yourpassword -device-name=Ubuntu -accept-tos
```

And you should be good to go! The Pawns.app container should be running with your credentials and making that sweet, sweet passive income in the background. It should launch automatically when you restart your PC.

### Checking Status

Let's check the current status:

```bash
sudo docker container ls -a
```

**Example Output:**
```text
CONTAINER ID   IMAGE                          COMMAND                  CREATED             STATUS              PORTS     NAMES
d6493e77f2d5   iproyal/pawns-cli:latest       "/pawns-cli -email..."   33 minutes ago      Up 9 minutes                  eloquent_turing
f982fa1225da   hello-world                    "/hello"                 48 minutes ago      Exited (0) 48 minutes ago             stoic_gauss
```

As you can see, the Pawns.app container is "Up". Note the `CONTAINER ID` value for your container because you can use it to check the log:

```bash
sudo docker container logs d6493e77f2d5
```

---

## Monitoring and Dashboard

Once running, you can check your active devices on the Pawns.app dashboard.

**Dashboard - Pawns.app Summary**
*   **YOUR BALANCE:** $75.384 (Minimum payout: $5)
*   **YOUR TRAFFIC:** 368.5161 GB

**ACTIVE DEVICES**
*   **Ubuntu**
    *   IP: [masked]
    *   Rate/GB: $0.2/GB
    *   Status: **Active**
*   **Phone**
    *   IP: [masked]
    *   Rate/GB: $0.2/GB
    *   Status: **Active**

> **Note:** If you see traffic value discrepancies between logs and the dashboard, don't worry as long as the earnings match up.

---

## FAQs

### Error: permission denied while trying to connect to the Docker socket
This is a permission issue. Add `sudo` at the beginning of the command to get elevated privileges. It's the equivalent of "Run as administrator" on Windows.

### Bash: syntax error near unexpected token
If your Pawns.app password contains strange characters, like `(` and `)`, it might trigger this. To get around this, simply change your password to one with standard alphanumeric characters.

### How do I stop the container from running?
If you want to stop your container, use the following command:

```bash
docker stop container_ID
```

Replace `container_ID` with your specific ID (found via `docker ps`).

---

**Happy earning!**