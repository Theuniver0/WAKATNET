# WAKATNET — conteneur de test de wg-agent (ticket 05 de la phase 2). Contexte : apps/wg-agent.
# Base Ubuntu 24.04 (comme radius/tests) ; la chaîne Go est recopiée de l'image officielle.
# wireguard-go (espace utilisateur) remplace le module WireGuard du noyau, absent du banc :
# wgctrl lui parle par la même API. Version liée à go.sum (golang.zx2c4.com/wireguard).
FROM golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac AS go

FROM ubuntu:24.04@sha256:2198e4c65076e9cb0b3d695219df667c0e3b0072da64ca3c2648aca17dcecaf5
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      iproute2 nftables iputils-ping ca-certificates gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/*
COPY --from=go /usr/local/go /usr/local/go
ENV PATH=/usr/local/go/bin:/root/go/bin:$PATH GOTOOLCHAIN=local
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download && go install golang.zx2c4.com/wireguard@v0.0.0-20231211153847-12269c276173 \
 && mv /root/go/bin/wireguard /usr/local/bin/wireguard-go
COPY . .
RUN go vet ./... && go vet -tags integration ./...
CMD ["sleep", "infinity"]
