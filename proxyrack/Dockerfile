FROM ubuntu:22.04

LABEL maintainer="kidpixel"
LABEL description="Proxyrack PoP Peer Client for Docker"

ENV DEBIAN_FRONTEND=noninteractive

# Configure APT sandbox for Docker build compatibility
RUN echo 'APT::Sandbox::User "root";' > /etc/apt/apt.conf.d/01sandbox && \
    echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        netcat-traditional \
        procps && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS (via nodesource, épinglé)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY run.sh /app/run.sh
RUN chmod +x /app/run.sh

# Non-root : l'utilisateur node a besoin d'écrire dans /app/data et /app
RUN useradd -m -u 1000 -s /bin/bash proxyrack && \
    chown -R proxyrack:proxyrack /app
USER proxyrack

VOLUME ["/app/data"]

ENTRYPOINT ["/bin/bash", "/app/run.sh"]
