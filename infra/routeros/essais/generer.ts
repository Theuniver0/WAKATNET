// WAKATNET — banc CHR (infra/routeros/essais/chr.sh) : produit les scripts RouterOS avec le VRAI générateur de l'API
// (apps/api/src/routeros.ts), pour qu'un RouterOS réel les exécute. Aucune logique de script ici.
//   node --experimental-strip-types generer.ts <etape1|etape2|entretien|desinstallation> <parametres.json> [inventaire.json]
import { readFileSync } from "node:fs";
import { desinstallation, entretien, etape1, etape2, type Inventaire, type Noeud } from "../../../apps/api/src/routeros.ts";

type Parametres = {
  urlPublique: string;
  jeton: string;
  overlayIp: string;
  secret: string;
  noeuds: Noeud[];
  portail: { hote: string; ips: string[] };
  urlEntretien?: string;
  coaPort?: number;
  listenPort?: number;
};

const [quoi, fichierParametres, fichierInventaire] = process.argv.slice(2);
const p = JSON.parse(readFileSync(fichierParametres, "utf8")) as Parametres;
/** Inventaire envoyé par l'étape 1 du routeur (corps du POST), tel quel. */
const inventaire = (): Inventaire => JSON.parse(readFileSync(fichierInventaire, "utf8")) as Inventaire;

switch (quoi) {
  case "etape1":
    process.stdout.write(etape1(p.urlPublique, p.jeton, new Date(Date.now() + 3600_000)));
    break;
  case "etape2":
    process.stdout.write(etape2({ overlayIp: p.overlayIp, secret: p.secret, noeuds: p.noeuds, inventaire: inventaire(),
                                  portail: p.portail, urlEntretien: p.urlEntretien }));
    break;
  case "entretien":
    process.stdout.write(entretien({ overlayIp: p.overlayIp, noeuds: p.noeuds, portail: p.portail,
                                     coaPort: p.coaPort ?? 3799, listenPort: p.listenPort ?? 13231 }));
    break;
  case "desinstallation":
    process.stdout.write(desinstallation(inventaire()));
    break;
  default:
    throw new Error(`script inconnu : ${quoi}`);
}
