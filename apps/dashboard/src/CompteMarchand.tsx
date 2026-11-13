import { useId, useState, type FormEvent } from "react";
import { appel } from "./api.ts";
import { Alerte, Choix, Ecran, Info, useAction } from "./ui.tsx";

type Fournisseur = "pawapay" | "cinetpay";
const NOMS: Record<Fournisseur, string> = { pawapay: "pawaPay", cinetpay: "CinetPay" };

/** Compte marchand du propriétaire (mode A, ADR 0013 ; pawaPay, ADR 0020 ; CinetPay, ADR 0022). Les clés ne sont
 *  jamais rendues : on les remplace en entier. pawaPay : l'adresse des callbacks est à recopier dans son tableau de
 *  bord. CinetPay : elle est transmise à chaque paiement, rien à recopier. */
export function CompteMarchand() {
  const [fournisseur, setFournisseur] = useState<Fournisseur>("pawapay");
  const [environnement, setEnvironnement] = useState("sandbox");
  const [cle, setCle] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [url, setUrl] = useState<{ fournisseur: Fournisseur; url: string } | null>(null);
  const { erreur, info, lancer, occupe } = useAction();
  const idCle = useId();
  const idMdp = useId();
  const enregistrer = (e: FormEvent) => {
    e.preventDefault();
    void lancer(async () => {
      try {
        const cles = fournisseur === "pawapay"
          ? { jeton: cle.trim(), environnement }
          : { cle_api: cle.trim(), mot_de_passe_api: motDePasse, environnement };
        const r = await appel<{ url_webhook: string }>("PUT", "/v1/compte-marchand", { corps: { fournisseur, cles } });
        setUrl({ fournisseur, url: r.url_webhook });
        return "Compte marchand enregistré.";
      } finally {
        setCle("");                     // vidés aussi en cas d'erreur : aucune clé ne reste dans la page
        setMotDePasse("");
      }
    });
  };
  // Audit du 13/11/2026 : un champ type="password" est proposé à l'enregistrement par le gestionnaire de mots de passe
  // du navigateur, qui ignore autoComplete="off". Champs texte, masqués par la feuille de style (CSP style-src 'self' :
  // une classe, pas de style en ligne), ignorés des gestionnaires connus.
  const secret = { type: "text", className: "secret-masque", required: true, autoComplete: "off", autoCorrect: "off",
    autoCapitalize: "off", spellCheck: false, "data-lpignore": "true", "data-1p-ignore": "", "data-bwignore": "",
    "data-form-type": "other" } as const;
  return (
    <Ecran titre="Compte marchand">
      <p>Les ventes en ligne arrivent sur <strong>votre</strong> compte {NOMS[fournisseur]}. WAKATNET y prélève sa commission sur vos crédits, jamais sur votre compte.</p>
      <form onSubmit={enregistrer} className="carte grille">
        <Choix libelle="Fournisseur" valeur={fournisseur} onChange={(v) => setFournisseur(v as Fournisseur)} requis
          options={[{ valeur: "pawapay", texte: "pawaPay" }, { valeur: "cinetpay", texte: "CinetPay" }]} />
        <Choix libelle="Environnement" valeur={environnement} onChange={setEnvironnement} requis
          options={[{ valeur: "sandbox", texte: "Bac à sable (essais, sans argent réel)" }, { valeur: "production", texte: "Production (argent réel)" }]} />
        <div className="champ">
          <label htmlFor={idCle}>{fournisseur === "pawapay" ? "Jeton d'API pawaPay" : "Clé d'API CinetPay (sk_test_… ou sk_live_…)"}</label>
          <input id={idCle} {...secret} value={cle} aria-describedby={`${idCle}-aide`} onChange={(e) => setCle(e.target.value)} />
          <span id={`${idCle}-aide`} className="aide">
            {fournisseur === "pawapay" ? "Tableau de bord pawaPay, rubrique des jetons d'API." : "Back-office CinetPay, compte du Burkina Faso."} Elle n'est plus jamais affichée ici.
          </span>
        </div>
        {fournisseur === "cinetpay" ? (
          <div className="champ">
            <label htmlFor={idMdp}>Mot de passe d'API CinetPay</label>
            <input id={idMdp} {...secret} value={motDePasse} onChange={(e) => setMotDePasse(e.target.value)} />
          </div>
        ) : null}
        <div className="champ"><button type="submit" disabled={occupe}>Enregistrer</button></div>
      </form>
      <Alerte message={erreur} />
      <Info message={info} />
      {url?.fournisseur === "pawapay" ? (
        <section aria-labelledby="titre-callback" className="carte">
          <h2 id="titre-callback">À faire dans le tableau de bord pawaPay</h2>
          <ol>
            <li>Adresse des callbacks de dépôt (« Deposit callback URL ») : <code>{url.url}</code></li>
            <li>Activer les <strong>callbacks signés</strong> (« signed callbacks ») : un callback non signé est refusé.</li>
          </ol>
        </section>
      ) : null}
      {url?.fournisseur === "cinetpay" ? (
        <section aria-labelledby="titre-notif" className="carte">
          <h2 id="titre-notif">CinetPay</h2>
          <p>L'adresse de notification (<code>{url.url}</code>) est envoyée à CinetPay avec chaque paiement : rien à recopier.
            Si votre compte filtre les adresses IP, autorisez celles des serveurs WAKATNET.</p>
        </section>
      ) : null}
    </Ecran>
  );
}
