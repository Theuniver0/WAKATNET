import { useState, type FormEvent } from "react";
import { envoyer, lire, type Paiement, type SyntheseArgent } from "./api.ts";
import { ETATS_PAIEMENT, dateHeure, franc } from "./format.ts";
import { Alerte, Champ, Ecran, useAction, useCharge } from "./ui.tsx";

export function Synthese({ debut, fin, detail = false }: { debut: string; fin: string; detail?: boolean }) {
  const q = new URLSearchParams();
  if (debut) q.set("debut", debut);
  if (fin) q.set("fin", fin);
  const qs = q.toString();
  const { donnees: s, erreur } = useCharge(() => lire<SyntheseArgent>(`/v1/argent/synthese${qs ? `?${qs}` : ""}`));
  return (
    <section aria-labelledby="titre-synthese">
      <h2 id="titre-synthese">{debut || fin ? "Synthèse de la période" : "Synthèse du mois"}</h2>
      <Alerte message={erreur} />
      {s ? (
        <dl className="synthese">
          <div><dt>Ventes en ligne</dt><dd className="montant">{franc(s.ventes_en_ligne_xof)}</dd><dd className="aide">{s.ventes_en_ligne} vente(s)</dd></div>
          <div><dt>Tickets papier activés</dt><dd className="montant">{franc(s.tickets_papier_xof)}</dd><dd className="aide">{s.tickets_papier_actives} ticket(s)</dd></div>
          <div><dt>Commissions</dt><dd className="montant">{franc(s.commissions_xof)}</dd></div>
          <div><dt>Frais papier</dt><dd className="montant">{franc(s.frais_papier_xof)}</dd></div>
          {detail ? <div><dt>Rechargements</dt><dd className="montant">{franc(s.recharges_xof)}</dd></div> : null}
          <div><dt>Solde de crédits</dt><dd className="montant">{franc(s.solde_credits_xof)}</dd></div>
        </dl>
      ) : erreur ? null : <p>Chargement…</p>}
    </section>
  );
}

export function Argent() {
  const moisCourant = new Date().toISOString().slice(0, 7);
  const [debut, setDebut] = useState("");
  const [fin, setFin] = useState("");
  const [periode, setPeriode] = useState({ debut: "", fin: "" });
  const [mois, setMois] = useState(moisCourant);
  const [numero, setNumero] = useState("");
  const [resultats, setResultats] = useState<Paiement[] | null>(null);
  const { erreur, lancer, occupe } = useAction();

  const q = new URLSearchParams();
  if (periode.debut) q.set("debut", periode.debut);
  if (periode.fin) q.set("fin", periode.fin);
  const qs = q.toString() ? `?${q.toString()}` : "";

  const afficher = (e: FormEvent) => { e.preventDefault(); setPeriode({ debut, fin }); };
  const rechercher = (e: FormEvent) => {
    e.preventDefault();
    void lancer(async () => { setResultats(await envoyer<Paiement[]>("/v1/paiements/recherche", { numero })); });
  };

  return (
    <Ecran titre="Suivi de l'argent">
      <form onSubmit={afficher} className="carte ligne">
        <Champ libelle="Du" type="date" valeur={debut} onChange={setDebut} />
        <Champ libelle="Au" type="date" valeur={fin} onChange={setFin} />
        <button type="submit">Afficher</button>
      </form>
      <Synthese key={`${periode.debut}|${periode.fin}`} debut={periode.debut} fin={periode.fin} detail />

      <section aria-labelledby="titre-releves">
        <h2 id="titre-releves">Relevés et facture</h2>
        <p className="ligne">
          <a className="bouton" href={`/v1/argent/releve.csv${qs}`} download>Relevé CSV</a>
          <a className="bouton" href={`/v1/argent/releve.pdf${qs}`} download>Relevé PDF</a>
        </p>
        <div className="carte ligne">
          <Champ libelle="Mois de la facture" type="month" valeur={mois} onChange={setMois} />
          <a className="bouton" href={`/v1/argent/facture.pdf?mois=${encodeURIComponent(mois || moisCourant)}`} download>Facture PDF</a>
        </div>
        <p className="aide">La facture est provisoire tant que les mentions fiscales ne sont pas fixées.</p>
      </section>

      <section aria-labelledby="titre-recherche">
        <h2 id="titre-recherche">Retrouver un paiement</h2>
        <form onSubmit={rechercher} className="carte ligne">
          <Champ libelle="Numéro du payeur" valeur={numero} onChange={setNumero} requis inputMode="numeric" autoComplete="off" />
          <button type="submit" disabled={occupe}>Rechercher</button>
        </form>
        <Alerte message={erreur} />
        {resultats !== null ? (
          resultats.length === 0 ? <p role="status">Aucun paiement pour ce numéro.</p> : (
            <table>
              <caption>Paiements trouvés</caption>
              <thead><tr><th scope="col">Numéro</th><th scope="col">Montant</th><th scope="col">Statut</th><th scope="col">Date</th><th scope="col">Site</th></tr></thead>
              <tbody>
                {resultats.map((p) => (
                  <tr key={p.reference}>
                    <th scope="row">{p.numero}</th>
                    <td className="montant">{franc(p.montant_xof)}</td>
                    <td>{ETATS_PAIEMENT[p.statut] ?? p.statut}</td>
                    <td>{dateHeure(p.le)}</td>
                    <td>{p.site}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </section>
    </Ecran>
  );
}
