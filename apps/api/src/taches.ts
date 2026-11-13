// WAKATNET — tâche périodique : expiration, rapprochement (verify fait foi), frais papier.
// Ticket : .scratch/phase-3-portail-paiement/issues/05-rapprochement.md ; ADR 0013 §6.
//   node src/taches.ts        un tour (minuterie systemd, toutes les 60 s)
// Une erreur sur un paiement (fournisseur en panne, P8) est journalisée sans arrêter le tour ;
// le paiement est replanifié 5 min plus tard. Sortie 1 si une erreur a eu lieu.
import type { Base } from "./base.ts";
import type { ServicePaiement } from "./paiement.ts";

export type Bilan = { expires: number; verifies: number; erreurs: number; frais: number; purges: number };

/** Budget d'un tour : bien en deçà de TimeoutStartSec (55 s), pour finir proprement. */
export const BUDGET_TOUR_MS = 40_000;

export async function tour(base: Base, service: ServicePaiement, journal: (m: string) => void = () => {},
                           budgetMs = BUDGET_TOUR_MS): Promise<Bilan> {
  const fin = Date.now() + budgetMs;
  // Frais papier et purge D'ABORD : une file de paiements à vérifier ne doit jamais les affamer (revue).
  const [{ n: frais }] = await base.$queryRaw<{ n: number }[]>`SELECT app.frais_papier_prelever(500) AS n`;
  const [{ n: purges }] = await base.$queryRaw<{ n: number }[]>`SELECT app.numeros_purger() AS n`;
  const [{ n: expires }] = await base.$queryRaw<{ n: number }[]>`SELECT app.paiements_expirer() AS n`;
  const a = await base.$queryRaw<{ reference: string; tenant_id: bigint }[]>`
    SELECT reference, tenant_id FROM app.paiements_a_verifier(200)`;
  let verifies = 0, erreurs = 0;
  for (const p of a) {
    if (Date.now() >= fin) { journal(`budget du tour atteint : ${a.length - verifies - erreurs} paiement(s) au tour suivant`); break; }
    // Replanifié AVANT l'appel : un tour interrompu (fournisseur muet, arrêt de systemd) ne laisse
    // jamais ce paiement en tête de file pour les tours suivants (revue).
    await base.$executeRaw`SELECT app.paiement_replanifier(${p.reference})`;
    try {
      const s = await service.rapprocher(p.reference, p.tenant_id, undefined, "rapprochement");
      verifies++;
      journal(`paiement=${p.reference} rapprochement=${s}`);
    } catch (e) {
      erreurs++;
      journal(`paiement=${p.reference} erreur=« ${e instanceof Error ? e.message.split("\n")[0] : String(e)} »`);
    }
  }
  return { expires, verifies, erreurs, frais, purges };
}

// Point d'entrée (pas lors d'un import par les tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { lireConfig } = await import("./config.ts");
  const { ouvrirBase } = await import("./base.ts");
  const { ServicePaiement } = await import("./paiement.ts");
  const config = lireConfig();
  if (!config.cles) { console.error("tâches : WAKATNET_CLE_MARCHANDS et WAKATNET_CLE_HMAC exigées"); process.exit(1); }
  const base = ouvrirBase(config.urlBase);
  try {
    // Nœud B en réplique (T13, ADR 0015 §2) : les tâches n'écrivent que sur le primaire.
    const [{ replique }] = await base.$queryRaw<{ replique: boolean }[]>`SELECT pg_is_in_recovery() AS replique`;
    if (replique) { console.log("tâches : réplique (pg_is_in_recovery), rien à faire sur ce nœud"); process.exit(0); }
    const b = await tour(base, new ServicePaiement(base, config.cles, config.urlPublique), (m) => console.log(m));
    console.log(`tour : ${b.expires} expiré(s), ${b.verifies} vérifié(s), ${b.erreurs} erreur(s), ${b.frais} frais papier, ${b.purges} numéro(s) purgé(s)`);
    process.exitCode = b.erreurs > 0 ? 1 : 0;
  } finally {
    await base.$disconnect();
  }
}
