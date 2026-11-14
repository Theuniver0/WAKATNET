import { useState, type FormEvent } from "react";
import { envoyer, lire, type Forfait, type Lot, type Moi, type PointDeVente, type StatPapier } from "./api.ts";
import { dateHeure, franc } from "./format.ts";
import { Alerte, Champ, Choix, Ecran, Info, useAction, useCharge } from "./ui.tsx";

type Reemission = { forfaits: { forfait_id: string; forfait: string; tickets: number; courts: number }[] };

export function Lots({ moi }: { moi: Moi }) {
  const peutGenerer = moi.role === "proprietaire" || moi.role === "gerant";
  const proprietaire = moi.role === "proprietaire";
  // Migration 0050 : tickets importés de Mikhmon jamais utilisés, à remplacer par des codes de la plateforme.
  const importes = useCharge(() => lire<Reemission>("/v1/imports/reemission"), proprietaire);
  const [pointReemission, setPointReemission] = useState("");
  const lots = useCharge(() => lire<Lot[]>("/v1/lots"));
  const stats = useCharge(() => lire<StatPapier[]>("/v1/stats/ventes-papier"));
  const forfaits = useCharge(() => lire<Forfait[]>("/v1/forfaits"), peutGenerer);
  const pdv = useCharge(() => lire<PointDeVente[]>("/v1/points-de-vente"), peutGenerer);
  const [forfait, setForfait] = useState("");
  const [point, setPoint] = useState("");
  const [quantite, setQuantite] = useState("");
  const { erreur, info, lancer, occupe } = useAction();

  const generer = (e: FormEvent) => {
    e.preventDefault();
    void lancer(async () => {
      const q = Number(quantite);
      if (!Number.isInteger(q) || q < 1 || q > 1000) throw new Error("Nombre de tickets : de 1 à 1 000.");
      await envoyer("/v1/lots", { forfait_id: forfait, point_de_vente_id: point, quantite: q });
      setQuantite("");
      lots.recharger(); stats.recharger();
      return "Tickets générés. Vous pouvez les imprimer.";
    });
  };
  const reemettre = (e: FormEvent) => {
    e.preventDefault();
    if (!window.confirm(`Remplacer ${aReemettre} ticket(s) Mikhmon ? Les anciens tickets ne fonctionneront plus, même ceux déjà vendus : `
      + "ne le faites que pour les tickets encore en stock. Cette action est définitive.")) return;
    void lancer(async () => {
      const r = await envoyer<{ tickets: number; lots: { id: string }[] }>("/v1/imports/reemission", { point_de_vente_id: pointReemission });
      importes.recharger(); lots.recharger(); stats.recharger();
      return `${r.tickets} ticket(s) remplacé(s), en ${r.lots.length} lot(s) ci-dessous : imprimez-les, retirez les anciens tickets de la vente, `
        + "et supprimez-les aussi du routeur (utilisateurs hotspot de Mikhmon), sinon le routeur pourrait encore les accepter.";
    });
  };
  const aReemettre = (importes.donnees?.forfaits ?? []).reduce((n, f) => n + f.tickets, 0);
  const remettre = (l: Lot) => void lancer(async () => {
    await envoyer(`/v1/lots/${l.id}/remis`);
    lots.recharger();
    return "Lot marqué remis.";
  });

  return (
    <Ecran titre="Tickets papier">
      {peutGenerer ? (
        <form onSubmit={generer} className="carte grille">
          <Choix libelle="Forfait" valeur={forfait} onChange={setForfait} requis
            options={(forfaits.donnees ?? []).filter((f) => f.actif).map((f) => ({ valeur: f.id, texte: `${f.nom} (${franc(f.prix_xof)})` }))} />
          <Choix libelle="Point de vente" valeur={point} onChange={setPoint} requis
            options={(pdv.donnees ?? []).map((p) => ({ valeur: p.id, texte: p.nom }))} />
          <Champ libelle="Nombre de tickets" type="number" min={1} max={1000} valeur={quantite} onChange={setQuantite} requis inputMode="numeric" />
          <div className="champ"><button type="submit" disabled={occupe}>Générer les tickets</button></div>
        </form>
      ) : null}
      <Alerte message={erreur ?? lots.erreur ?? forfaits.erreur ?? pdv.erreur ?? importes.erreur} />
      <Info message={info} />

      {proprietaire && aReemettre > 0 ? (
        <section aria-labelledby="titre-reemission" className="carte">
          <h2 id="titre-reemission">Tickets importés de Mikhmon</h2>
          <p>
            {aReemettre} ticket(s) importé(s) n'ont jamais servi. Leurs codes, souvent courts, se devinent plus facilement que
            ceux de WAKATNET. Vous pouvez les remplacer par des codes de la plateforme, avec le même forfait : les anciens
            tickets ne fonctionneront plus, même ceux déjà vendus : ne le faites que pour les tickets encore en stock. Il faudra
            imprimer les nouveaux, retirer les anciens de la vente et les supprimer du routeur (utilisateurs hotspot de Mikhmon).
          </p>
          <ul>
            {(importes.donnees?.forfaits ?? []).map((f) => (
              <li key={f.forfait_id}>{f.forfait} : {f.tickets} ticket(s), dont {f.courts} à code court</li>
            ))}
          </ul>
          <form onSubmit={reemettre} className="grille">
            <Choix libelle="Point de vente des nouveaux tickets" valeur={pointReemission} onChange={setPointReemission} requis
              options={(pdv.donnees ?? []).map((p) => ({ valeur: p.id, texte: p.nom }))} />
            <div className="champ"><button type="submit" disabled={occupe}>Remplacer ces tickets</button></div>
          </form>
        </section>
      ) : null}

      <section aria-labelledby="titre-lots">
        <h2 id="titre-lots">Vos lots</h2>
        {lots.donnees && lots.donnees.length === 0 ? <p>Aucun lot de tickets.</p> : null}
        {lots.donnees && lots.donnees.length > 0 ? (
          <table>
            <caption>Lots de tickets papier</caption>
            <thead>
              <tr>
                <th scope="col">Lot</th><th scope="col">Forfait</th><th scope="col">Point de vente</th><th scope="col">Créé le</th>
                <th scope="col">Générés</th><th scope="col">Remis</th><th scope="col">Activés</th><th scope="col">Expirés</th><th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {lots.donnees.map((l) => (
                <tr key={l.id}>
                  <th scope="row">n° {l.id}</th>
                  <td>{l.forfait}</td>
                  <td>{l.point_de_vente}</td>
                  <td>{dateHeure(l.cree_le)}</td>
                  <td>{l.etats.genere}</td>
                  <td>{l.etats.remis}</td>
                  <td>{l.etats.active}</td>
                  <td>{l.etats.expire}</td>
                  <td>
                    <div className="ligne">
                      {peutGenerer ? <a href={`/v1/lots/${l.id}/tickets.pdf`} download>Imprimer (PDF)</a> : null}
                      {l.remis_le === null
                        ? <button type="button" className="secondaire" onClick={() => remettre(l)} disabled={occupe}>Marquer remis</button>
                        : <span>Remis le {dateHeure(l.remis_le)}</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>

      <section aria-labelledby="titre-stats">
        <h2 id="titre-stats">Statistiques par point de vente</h2>
        <Alerte message={stats.erreur} />
        {stats.donnees && stats.donnees.length === 0 ? <p>Pas encore de statistiques.</p> : null}
        {stats.donnees && stats.donnees.length > 0 ? (
          <table>
            <caption>Ventes de tickets papier</caption>
            <thead><tr><th scope="col">Point de vente</th><th scope="col">Auteur</th><th scope="col">Tickets</th><th scope="col">Activés</th><th scope="col">Valeur activée</th></tr></thead>
            <tbody>
              {stats.donnees.map((s) => (
                <tr key={`${s.point_de_vente_id}|${s.utilisateur}`}>
                  <th scope="row">{s.point_de_vente}</th>
                  <td>{s.utilisateur}</td><td>{s.tickets}</td><td>{s.actives}</td>
                  <td className="montant">{franc(s.valeur_activee_xof)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </Ecran>
  );
}
