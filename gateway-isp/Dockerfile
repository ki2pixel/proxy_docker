FROM alpine:3.19

# Import tun2socks binary (épinglé v2.5.2) et dnsproxy (épinglé v0.84.1)
COPY --from=xjasonlyu/tun2socks:v2.5.2 /usr/bin/tun2socks /usr/local/bin/tun2socks
COPY --from=adguard/dnsproxy:v0.84.1 /opt/dnsproxy/dnsproxy /usr/local/bin/dnsproxy

# Install network utilities, curl, socat, bash and CA certificates
RUN apk add --no-cache \
    iproute2 \
    iptables \
    curl \
    ca-certificates \
    socat \
    bash \
    bind-tools \
    jq

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY healthcheck.sh /usr/local/bin/healthcheck.sh

RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/healthcheck.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
