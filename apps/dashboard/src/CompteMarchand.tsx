import { useId, useState, type FormEvent } from "react";
import { appel } from "./api.ts";
import { Alerte, Ecran, Info, useAction } from "./ui.tsx";

type Reponse = { url_webhook: string; ips_serveurs: string[]; url_portail: string | null };

/** Compte marchand du propriétaire (mode A, ADR 0013 ; MoneyFusion, ADR 0024). Le lien API vaut clé : il n'est jamais
 *  rendu ; on le remplace en entier. MoneyFusion n'accepte que les IP déclarées dans l'application du marchand : la
 *  page rappelle lesquelles saisir. MoneyFusion n'a pas de bac à sable : un compte enregistré encaisse de l'argent réel,
 *  ce que la plateforme refuse avant G-ARGENT. */
export function CompteMarchand() {
  const [lien, setLien] = useState("");
  const [rep, setRep] = useState<Reponse | null>(null);
  const { erreur, info, lancer, occupe } = useAction();
  const idLien = useId();
  const enregistrer = (e: FormEvent) => {
    e.preventDefault();
    void lancer(async () => {
      try {
        const r = await appel<Reponse>("PUT", "/v1/compte-marchand", { corps: { fournisseur: "moneyfusion", cles: { lien_api: lien.trim() } } });
        setRep(r);
        return "Compte marchand enregistré.";
      } finally {
        setLien("");                    // vidé aussi en cas d'erreur : aucune clé ne reste dans la page
      }
    });
  };
  // Audit du 13/11/2026 : un champ type="password" est proposé à l'enregistrement par le gestionnaire de mots de passe
  // du navigateur, qui ignore autoComplete="off". Champ texte, masqué par la feuille de style (CSP style-src 'self').
  const secret = { type: "text", className: "secret-masque", required: true, autoComplete: "off", autoCorrect: "off",
    autoCapitalize: "off", spellCheck: false, "data-lpignore": "true", "data-1p-ignore": "", "data-bwignore": "",
    "data-form-type": "other" } as const;
  return (
    <Ecran titre="Compte marchand">
      <p>Les ventes en ligne arrivent sur <strong>votre</strong> compte MoneyFusion. WAKATNET y prélève sa commission sur vos crédits, jamais sur votre compte.</p>
      <form onSubmit={enregistrer} className="carte grille">
        <div className="champ">
          <label htmlFor={idLien}>Lien API MoneyFusion</label>
          <input id={idLien} {...secret} value={lien} aria-describedby={`${idLien}-aide`} onChange={(e) => setLien(e.target.value)} />
          <span id={`${idLien}-aide`} className="aide">
            Tableau de bord MoneyFusion, rubrique « API de paiement », après validation de votre application. Il n'est plus jamais affiché ici.
          </span>
        </div>
        <div className="champ"><button type="submit" disabled={occupe}>Enregistrer</button></div>
      </form>
      <Alerte message={erreur} />
      <Info message={info} />
      {rep ? (
        <section aria-labelledby="titre-mf" className="carte">
          <h2 id="titre-mf">À faire dans votre application MoneyFusion</h2>
          <ol>
            <li>Adresses IP autorisées : {rep.ips_serveurs.length > 0
              ? rep.ips_serveurs.map((ip, i) => <span key={ip}>{i > 0 ? ", " : ""}<code>{ip}</code></span>)
              : "celles des serveurs WAKATNET, communiquées par le support"}. Toute autre adresse est bloquée par MoneyFusion.</li>
            {rep.url_portail ? <li>Site de l'application : <code>{rep.url_portail}</code> (vos clients y reviennent après le paiement).</li> : null}
            <li>L'adresse de notification (<code>{rep.url_webhook}</code>) est envoyée avec chaque paiement : rien à recopier.</li>
          </ol>
        </section>
      ) : null}
    </Ecran>
  );
}
