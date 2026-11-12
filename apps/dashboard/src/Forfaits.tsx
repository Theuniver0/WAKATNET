import { useState, type FormEvent } from "react";
import { envoyer, lire, modifier, type Forfait, type Moi } from "./api.ts";
import { duree, entierOuNull, franc } from "./format.ts";
import { Alerte, Champ, Ecran, Info, useAction, useCharge } from "./ui.tsx";

export function Forfaits({ moi }: { moi: Moi }) {
  const ecriture = moi.role === "proprietaire";
  const liste = useCharge(() => lire<Forfait[]>("/v1/forfaits"));
  const [nom, setNom] = useState("");
  const [prix, setPrix] = useState("");
  const [minutes, setMinutes] = useState("");
  const [heures, setHeures] = useState("");
  const [debit, setDebit] = useState("");
  const [appareils, setAppareils] = useState("1");
  const { erreur, info, lancer, occupe } = useAction();

  const creer = (e: FormEvent) => {
    e.preventDefault();
    void lancer(async () => {
      const p = entierOuNull(prix), m = entierOuNull(minutes), h = entierOuNull(heures), a = entierOuNull(appareils);
      if (p === null || Number.isNaN(p)) throw new Error("Prix : un nombre entier de francs.");
      if (Number.isNaN(m) || Number.isNaN(h) || Number.isNaN(a)) throw new Error("Durée, validité et appareils : des nombres entiers.");
      if (m === null && h === null) throw new Error("Indiquez une durée de connexion ou une validité.");
      const corps: Record<string, unknown> = {
        nom, prix_xof: p, uptime_limit_s: m === null ? null : m * 60, validity_s: h === null ? null : h * 3600,
        rate_limit: debit.trim() === "" ? null : debit.trim(),
      };
      if (a !== null) corps.devices = a;
      await envoyer("/v1/forfaits", corps);
      setNom(""); setPrix(""); setMinutes(""); setHeures(""); setDebit(""); setAppareils("1");
      liste.recharger();
      return "Forfait créé.";
    });
  };
  const basculer = (f: Forfait) => void lancer(async () => {
    await modifier(`/v1/forfaits/${f.id}`, { actif: !f.actif });
    liste.recharger();
    return f.actif ? "Forfait retiré de la vente." : "Forfait remis en vente.";
  });

  return (
    <Ecran titre="Forfaits">
      {ecriture ? (
        <form onSubmit={creer} className="carte grille">
          <Champ libelle="Nom" valeur={nom} onChange={setNom} requis />
          <Champ libelle="Prix (F)" type="number" min={0} valeur={prix} onChange={setPrix} requis inputMode="numeric" />
          <Champ libelle="Durée de connexion (minutes)" type="number" min={1} valeur={minutes} onChange={setMinutes} inputMode="numeric" />
          <Champ libelle="Validité (heures)" type="number" min={1} valeur={heures} onChange={setHeures} inputMode="numeric" />
          <Champ libelle="Débit (ex. 2M/2M)" valeur={debit} onChange={setDebit} />
          <Champ libelle="Appareils" type="number" min={1} max={64} valeur={appareils} onChange={setAppareils} inputMode="numeric" />
          <div className="champ"><button type="submit" disabled={occupe}>Créer le forfait</button></div>
        </form>
      ) : <p>Vous consultez les forfaits en lecture seule.</p>}
      <Alerte message={erreur ?? liste.erreur} />
      <Info message={info} />
      {liste.donnees && liste.donnees.length === 0 ? <p>Aucun forfait pour l'instant.</p> : null}
      {liste.donnees && liste.donnees.length > 0 ? (
        <table>
          <caption>Forfaits</caption>
          <thead>
            <tr>
              <th scope="col">Nom</th><th scope="col">Prix</th><th scope="col">Durée de connexion</th><th scope="col">Validité</th>
              <th scope="col">Débit</th><th scope="col">Appareils</th><th scope="col">État</th>
              {ecriture ? <th scope="col">Action</th> : null}
            </tr>
          </thead>
          <tbody>
            {liste.donnees.map((f) => (
              <tr key={f.id}>
                <th scope="row">{f.nom}</th>
                <td className="montant">{franc(f.prix_xof)}</td>
                <td>{duree(f.uptime_limit_s)}</td>
                <td>{duree(f.validity_s)}</td>
                <td>{f.rate_limit ?? "Libre"}</td>
                <td>{f.devices}</td>
                <td>{f.actif ? "En vente" : "Retiré"}</td>
                {ecriture ? (
                  <td><button type="button" className="secondaire" onClick={() => basculer(f)} disabled={occupe}>
                    {f.actif ? "Retirer de la vente" : "Remettre en vente"}</button></td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Ecran>
  );
}
