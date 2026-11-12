import type { Moi } from "./api.ts";
import { Synthese } from "./Argent.tsx";
import { Ecran } from "./ui.tsx";

export function Accueil({ moi }: { moi: Moi }) {
  if (moi.role === "proprietaire") {
    return (
      <Ecran titre="Tableau de bord">
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
