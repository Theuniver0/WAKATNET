import { useCallback, useEffect, useState, type ReactElement } from "react";
import { appel, envoyer, ErreurApi, messageDe, surSession, type Moi, type Role } from "./api.ts";
import { Accueil } from "./Accueil.tsx";
import { Admin } from "./Admin.tsx";
import { Argent } from "./Argent.tsx";
import { Connexion, Inscription, Totp } from "./Connexion.tsx";
import { Forfaits } from "./Forfaits.tsx";
import { Lots } from "./Lots.tsx";
import { PointsDeVente } from "./PointsDeVente.tsx";
import { aller, useChemin } from "./routeur.ts";
import { Sites } from "./Sites.tsx";
import { Verifier } from "./Verifier.tsx";
import { CompteMarchand } from "./CompteMarchand.tsx";
import { Alerte } from "./ui.tsx";

type Page = { chemin: string; libelle: string; roles: Role[]; rendu: (moi: Moi) => ReactElement };

const PAGES: Page[] = [
  { chemin: "/", libelle: "Tableau de bord", roles: ["proprietaire", "gerant", "vendeur"], rendu: (m) => <Accueil moi={m} /> },
  { chemin: "/sites", libelle: "Sites et routeurs", roles: ["proprietaire"], rendu: (m) => <Sites moi={m} /> },
  { chemin: "/forfaits", libelle: "Forfaits", roles: ["proprietaire", "gerant", "vendeur"], rendu: (m) => <Forfaits moi={m} /> },
  { chemin: "/points-de-vente", libelle: "Points de vente", roles: ["proprietaire"], rendu: () => <PointsDeVente /> },
  { chemin: "/lots", libelle: "Tickets papier", roles: ["proprietaire", "gerant", "vendeur"], rendu: (m) => <Lots moi={m} /> },
  { chemin: "/argent", libelle: "Suivi de l'argent", roles: ["proprietaire"], rendu: () => <Argent /> },
  { chemin: "/compte-marchand", libelle: "Compte marchand", roles: ["proprietaire"], rendu: () => <CompteMarchand /> },
  { chemin: "/admin", libelle: "Administration", roles: ["super_admin"], rendu: () => <Admin /> },
];

/** Écran réellement affiché, selon la connexion et le rôle. */
function effectif(chemin: string, moi: Moi | null): string {
  if (chemin === "/verifier") return "/verifier";          // lien de vérification (ADR 0017) : connecté ou non
  if (moi === null) return chemin === "/inscription" ? "/inscription" : "/connexion";
  if (moi.role === "super_admin") {
    if (!moi.totp_ok) return "/totp";
    return "/admin";
  }
  return PAGES.some((p) => p.chemin === chemin && p.roles.includes(moi.role)) ? chemin : "/";
}

export function App() {
  const [moi, setMoi] = useState<Moi | null | undefined>(undefined);
  const [panne, setPanne] = useState<string | null>(null);
  const chemin = useChemin();

  const charger = useCallback(async () => {
    try {
      setMoi(await appel<Moi>("GET", "/v1/moi", { sans401: true }));
      setPanne(null);
    } catch (e) {
      if (e instanceof ErreurApi && e.statut === 401) setMoi(null);
      else { setMoi(null); setPanne(messageDe(e)); }
    }
  }, []);

  useEffect(() => {
    surSession(() => setMoi(null));
    void charger();
  }, [charger]);

  const cible = moi === undefined ? chemin : effectif(chemin, moi);
  useEffect(() => { if (moi !== undefined && cible !== chemin) aller(cible); }, [moi, cible, chemin]);

  const deconnecter = async () => {
    try { await envoyer("/v1/deconnexion", {}, { sans401: true }); } catch { /* la session est de toute façon abandonnée */ }
    setMoi(null);
    aller("/connexion");
  };

  const pages = moi ? PAGES.filter((p) => p.roles.includes(moi.role)) : [];
  let contenu: ReactElement;
  if (moi === undefined) contenu = <p role="status">Chargement…</p>;
  else if (cible === "/verifier") contenu = <Verifier />;
  else if (moi === null) contenu = cible === "/inscription" ? <Inscription apres={charger} /> : <Connexion apres={charger} />;
  else if (cible === "/totp") contenu = <Totp apres={charger} />;
  else contenu = PAGES.find((p) => p.chemin === cible)?.rendu(moi) ?? <Accueil moi={moi} />;

  return (
    <>
      <a className="evitement" href="#contenu" onClick={(e) => { e.preventDefault(); document.getElementById("contenu")?.focus(); }}>Aller au contenu</a>
      <header className="entete">
        <p className="marque">WAKATNET</p>
        {moi ? <button type="button" className="secondaire" onClick={() => void deconnecter()}>Se déconnecter</button> : null}
      </header>
      {moi && pages.length > 0 && cible !== "/totp" ? (
        <nav aria-label="Navigation principale" className="menu">
          <ul>
            {pages.map((p) => (
              <li key={p.chemin}>
                <a href={`#${p.chemin}`} aria-current={p.chemin === cible ? "page" : undefined}>{p.libelle}</a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <main id="contenu" tabIndex={-1}>
        <Alerte message={panne} />
        {contenu}
      </main>
    </>
  );
}
