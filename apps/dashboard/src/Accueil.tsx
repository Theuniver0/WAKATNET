import { lire, type Moi } from "./api.ts";
import { Synthese } from "./Argent.tsx";
import { franc } from "./format.ts";
import { Alerte, Ecran, useCharge } from "./ui.tsx";

type AlerteCredits = { bas: boolean; solde_xof: number; dernier_rechargement_xof: number | null };

/** SPEC §8.2 : alerte quand le solde de crédits passe sous 20 % du dernier rechargement (migration 0041). */
function AlerteCreditsBas() {
  const { donnees: a } = useCharge(() => lire<AlerteCredits>("/v1/argent/alerte"));
  if (!a?.bas) return null;
  return (
    <Alerte message={`Crédits bas : ${franc(a.solde_xof)} restants, sous 20 % de votre dernier rechargement`
      + `${a.dernier_rechargement_xof !== null ? ` (${franc(a.dernier_rechargement_xof)})` : ""}. Rechargez auprès de Telecom Universel : `
      + "au-delà du découvert autorisé, la vente en ligne est suspendue."} />
  );
}

export function Accueil({ moi }: { moi: Moi }) {
  if (moi.role === "proprietaire") {
    return (
      <Ecran titre="Tableau de bord">
        <AlerteCreditsBas />
        <Synthese debut="" fin="" />
        <p>Besoin du détail ? Voir le <a href="#/argent">suivi de l'argent</a>.</p>
      </Ecran>
    );
  }
  return (
    <Ecran titre="Tableau de bord">
      <p>Bonjour {moi.email}. Retrouvez vos <a href="#/lots">tickets papier</a> et les <a href="#/forfaits">forfaits</a> en vente.</p>
    </Ecran>
  );
}
