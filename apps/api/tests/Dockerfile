# WAKATNET — conteneur de test de l'API (ticket 02 de la phase 2). Contexte de construction :
# la racine du dépôt (lockfile npm de l'espace de travail). Node 22 officiel, même empreinte
# que radius/tests/Dockerfile.testeur (le paquet Ubuntu ne retire pas les types TypeScript).
FROM node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2
WORKDIR /depot
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
RUN npm ci --no-audit --no-fund
COPY packages/payments packages/payments
COPY apps/api apps/api
# Page de connexion du hotspot, testée par tests/login.test.ts.
COPY routeros/hotspot routeros/hotspot
WORKDIR /depot/apps/api
RUN npx prisma generate
USER node
CMD ["sleep", "infinity"]
