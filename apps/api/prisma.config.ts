// Prisma n'est que le CLIENT de l'API (ADR 0012 §5) : aucune migration Prisma.
// Le schéma est tiré de la base migrée par infra/sql/migrer.sh (prisma db pull).
import { defineConfig } from "prisma/config";

export default defineConfig({
  // WAKATNET_PRISMA_SCHEMA : copie temporaire tirée par tests/divergence.test.ts.
  schema: process.env.WAKATNET_PRISMA_SCHEMA ?? "prisma/schema.prisma",
  datasource: { url: process.env.WAKATNET_PRISMA_PULL_URL ?? "postgresql://inutilise@127.0.0.1/inutilise" },
});
