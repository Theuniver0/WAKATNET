// WAKATNET — accès à la base pour l'API : Prisma (client seulement, ADR 0012 §5) sous wk_api.
// Chaque requête d'un propriétaire tourne dans UNE transaction qui pose le contexte RLS par
// set_config(..., true) : portée de la transaction, donc aucune fuite entre deux requêtes qui
// partagent une connexion du pool (ADR 0012 §6).
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../genere/prisma/client.ts";

export type Base = PrismaClient;
export type Tx = Prisma.TransactionClient;

export function ouvrirBase(url: string): Base {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, application_name: "wakatnet-api" }) });
}

export function enTantQue<T>(base: Base, tenantId: bigint, travail: (tx: Tx) => Promise<T>): Promise<T> {
  return base.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('wakatnet.tenant_id', ${tenantId.toString()}, true)`;
    return travail(tx);
  });
}
