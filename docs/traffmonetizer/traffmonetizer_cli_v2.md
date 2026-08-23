# traffmonetizer/cli_v2

**By traffmonetizer** · Updated 6 months ago  
*Make money online easily! Official repository*  
`IMAGE` `NETWORKING` | ⭐ 48 | 📥 10M+

---

## Pulling image

```bash
docker pull traffmonetizer/cli_v2:latest
```

ARM is also supported:

```bash
docker pull traffmonetizer/cli_v2:arm64v8
docker pull traffmonetizer/cli_v2:arm32v7
```

---

## Running interactive mode

```bash
docker run -i --name tm traffmonetizer/cli_v2 start accept --token your_token_here
```

---

## Interactive commands list

- `start` - connects to the server
- `stop` - disconnects from the server
- `accept` - indicates that the application can accept traffic
- `end-accept` - indicates that the application couldn't accept traffic, but does not disconnect from the server
- `statistics` - statistics. Outputted in the format `'Inbound: {value}; Outgoing: {value}; Requests: {value}'`
- `status` - connection status. Outputted in the format `'Connected: {True / False}; Accepting: {True / False}'`
- `exit` - stopping the application

You can also set the name of device with parameter `--device-name`. It will be displayed in the user panel of website and can make device management more convenient.

```bash
docker run -i --name tm traffmonetizer/cli_v2 start accept --token your_token_here --device-name your_device_name
```

---

## Running detached mode

```bash
docker run -d --name tm traffmonetizer/cli_v2 start accept --token your_token_here
```

---

## Setup an auto update

We strongly recommend setup automatic updates as it could affect earnings!

```bash
docker run -d --name watchtower -v /var/run/docker.sock:/var/run/docker.sock containrrr/watchtower --cleanup --interval 43200 tm
```

In case with multiple container setup do not set a name:

```bash
docker run -d --name watchtower -v /var/run/docker.sock:/var/run/docker.sock containrrr/watchtower --cleanup --interval 43200
```

---

## Running on machines with multiple IPs

First, create docker networks for multiple IPs:

```bash
docker network create my_network_1 --driver bridge --subnet 192.168.33.0/24
docker network create my_network_2 --driver bridge --subnet 192.168.34.0/24
...
```

The second step is to route traffic from these subnets to public IPs:

```bash
iptables -t nat -I POSTROUTING -s 192.168.33.0/24 -j SNAT --to-source {my_ip_1}
iptables -t nat -I POSTROUTING -s 192.168.34.0/24 -j SNAT --to-source {my_ip_2}
...
```

Run Traffmonetizer instances with these networks:

```bash
docker run -d --network my_network_1 --name tm_1 traffmonetizer/cli_v2 start accept --token {token}
docker run -d --network my_network_2 --name tm_2 traffmonetizer/cli_v2 start accept --token {token}
...
```

---

## Tag summary

- **Recent tags:** `latest`
- **Content type:** Image
- **Digest:** `sha256:6dbf8e75c...`
- **Size:** 1.3 MB
- **Last updated:** 6 months ago
- **Quick pull:** `docker pull traffmonetizer/cli_v2`
