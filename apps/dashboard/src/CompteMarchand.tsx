import { useId, useState, type FormEvent } from "react";
import { appel } from "./api.ts";
import { Alerte, Choix, Ecran, Info, useAction } from "./ui.tsx";

/** Compte marchand du propriétaire (mode A, ADR 0013 ; pawaPay, ADR 0020). Les clés ne sont jamais rendues : on les
 *  remplace en entier. Après l'enregistrement, l'adresse des callbacks est à recopier dans le tableau de bord pawaPay. */
export function CompteMarchand() {
  const [environnement, setEnvironnement] = useState("sandbox");
  const [cle, setCle] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const { erreur, info, lancer, occupe } = useAction();
  const idCle = useId();
  const enregistrer = (e: FormEvent) => {
    e.preventDefault();
    void lancer(async () => {
      try {
        const r = await appel<{ url_webhook: string }>("PUT", "/v1/compte-marchand",
          { corps: { fournisseur: "pawapay", cles: { jeton: cle.trim(), environnement } } });
        setUrl(r.url_webhook);
        return "Compte marchand enregistré.";
      } finally {
        setCle("");                     // vidé aussi en cas d'erreur : le jeton ne reste pas dans la page
      }
    });
  };
  return (
    <Ecran titre="Compte marchand">
      <p>Les ventes en ligne arrivent sur <strong>votre</strong> compte pawaPay. WAKATNET y prélève sa commission sur vos crédits, jamais sur votre compte.</p>
      <form onSubmit={enregistrer} className="carte grille">
        <Choix libelle="Environnement" valeur={environnement} onChange={setEnvironnement} requis
          options={[{ valeur: "sandbox", texte: "Bac à sable (essais, sans argent réel)" }, { valeur: "production", texte: "Production (argent réel)" }]} />
        {/* Audit du 13/11/2026 : un champ type="password" est proposé à l'enregistrement par le gestionnaire de mots de
            passe du navigateur, qui ignore autoComplete="off". Champ texte, masqué par la feuille de style (CSP
            style-src 'self' : une classe, pas de style en ligne), ignoré des gestionnaires connus. */}
        <div className="champ">
          <label htmlFor={idCle}>Jeton d'API pawaPay</label>
          <input id={idCle} type="text" className="secret-masque" value={cle} required autoComplete="off"
            autoCorrect="off" autoCapitalize="off" spellCheck={false} data-lpignore="true" data-1p-ignore=""
            data-bwignore="" data-form-type="other" aria-describedby={`${idCle}-aide`} onChange={(e) => setCle(e.target.value)} />
          <span id={`${idCle}-aide`} className="aide">Tableau de bord pawaPay, rubrique des jetons d'API. Il n'est plus jamais affiché ici.</span>
        </div>
        <div className="champ"><button type="submit" disabled={occupe}>Enregistrer</button></div>
      </form>
      <Alerte message={erreur} />
      <Info message={info} />
      {url ? (
        <section aria-labelledby="titre-callback" className="carte">
          <h2 id="titre-callback">À faire dans le tableau de bord pawaPay</h2>
          <ol>
            <li>Adresse des callbacks de dépôt (« Deposit callback URL ») : <code>{url}</code></li>
            <li>Activer les <strong>callbacks signés</strong> (« signed callbacks ») : un callback non signé est refusé.</li>
          </ol>
        </section>
      ) : null}
    </Ecran>
  );
}
