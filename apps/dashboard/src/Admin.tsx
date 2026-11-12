import { useState } from "react";
import { envoyer, lire, modifier, type Proprietaire } from "./api.ts";
import { franc } from "./format.ts";
import { Alerte, Champ, Ecran, Info, useAction, useCharge } from "./ui.tsx";

function Ligne({ p, apres }: { p: Proprietaire; apres: () => void }) {
  const [montant, setMontant] = useState("");
  const [reference, setReference] = useState("");
  const { erreur, info, lancer, occupe } = useAction();
  const recharger = () => void lancer(async () => {
    const m = Number(montant);
    if (!Number.isInteger(m) || m < 1) throw new Error("Montant : un nombre entier de francs.");
    await envoyer(`/admin/v1/proprietaires/${p.id}/recharges`, { montant_xof: m, reference: reference.trim() });
    setMontant(""); setReference(""); apres();
    return "Crédits rechargés.";
  });
  const suspendre = () => void lancer(async () => {
    await modifier(`/admin/v1/proprietaires/${p.id}`, { suspendu: !p.suspendu });
    apres();
    return p.suspendu ? "Propriétaire réactivé." : "Propriétaire suspendu.";
  });
  return (
    <tr>
      <th scope="row">{p.nom}</th>
      <td>{p.suspendu ? "Suspendu" : "Actif"}</td>
      <td className="montant">{franc(p.solde_credits_xof)}</td>
      <td className="montant">{franc(p.ventes_en_ligne_xof)}</td>
      <td className="montant">{franc(p.commissions_xof)}</td>
      <td>
        <div className="grille-ligne">
          <Champ libelle="Montant à recharger (F)" type="number" min={1} valeur={montant} onChange={setMontant} inputMode="numeric" />
          <Champ libelle="Référence du reçu" valeur={reference} onChange={setReference} />
          <button type="button" onClick={recharger} disabled={occupe}>Recharger</button>
          <button type="button" className={p.suspendu ? "secondaire" : "danger"} onClick={suspendre} disabled={occupe}>
            {p.suspendu ? "Réactiver" : "Suspendre"}</button>
        </div>
        <Alerte message={erreur} />
        <Info message={info} />
      </td>
    </tr>
  );
}

export function Admin() {
  const liste = useCharge(() => lire<Proprietaire[]>("/admin/v1/proprietaires"));
  return (
    <Ecran titre="Administration">
      <Alerte message={liste.erreur} />
      {liste.donnees && liste.donnees.length === 0 ? <p>Aucun propriétaire.</p> : null}
      {liste.donnees && liste.donnees.length > 0 ? (
        <table>
          <caption>Propriétaires (mois en cours)</caption>
          <thead>
            <tr><th scope="col">Propriétaire</th><th scope="col">État</th><th scope="col">Solde de crédits</th><th scope="col">Ventes en ligne</th><th scope="col">Commissions</th><th scope="col">Actions</th></tr>
          </thead>
          <tbody>{liste.donnees.map((p) => <Ligne key={p.id} p={p} apres={liste.recharger} />)}</tbody>
        </table>
      ) : null}
    </Ecran>
  );
}
