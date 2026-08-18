# PacketStream Installation Guide

Run the following command to install (requires Docker):

> **Important:** This command includes configuration parameters to log-in to your account when the docker container starts and will auto-update when a new client version is pushed. If you modify the install command, PacketStream may not function properly.

```bash
# Cleanup existing containers and images, then run the client and watchtower
sudo docker stop watchtower; sudo docker rm watchtower; sudo docker rmi containrrr/watchtower; \
sudo docker stop psclient; sudo docker rm psclient; sudo docker rmi packetstream/psclient; \
sudo docker run -d --restart=always -e CID=3J27 \
--name psclient packetstream/psclient:latest && sudo docker run -d --restart=always \
--name watchtower -v /var/run/docker.sock:/var/run/docker.sock containrrr/watchtower \
--cleanup-include-stopped --include-restarting --revive-stopped --interval 60 psclient
```

---

### Prerequisites
* **Docker:** Ensure Docker is installed and running on your system.
* **Permissions:** You may need `sudo` privileges to execute these commands.
* **Internet Connection:** A stable connection is required for the client to function and for updates to be downloaded.