import { useState, type FormEvent } from "react";
import { envoyer, lire, modifier, type PointDeVente } from "./api.ts";
import { Alerte, Champ, Choix, Ecran, Info, useAction, useCharge } from "./ui.tsx";

type Utilisateur = { id: string; email: string; role: string; point_of_sale_id: string | null; actif: boolean };

// Revue de sécurité M3 : couper l'accès d'un gérant ou d'un vendeur (PUT /v1/utilisateurs/:id { actif: false }).
// Ses sessions sont fermées sur-le-champ ; l'action est définitive et auditée (migration 0030).
function AccesLigne({ u, pdv, apres }: { u: Utilisateur; pdv: string; apres: () => void }) {
  const [confirme, setConfirme] = useState(false);
  const { erreur, lancer, occupe } = useAction();
  const couper = () => void lancer(async () => {
    await modifier(`/v1/utilisateurs/${u.id}`, { actif: false });
    setConfirme(false);
    apres();
  });
  return (
    <tr>
      <th scope="row">{u.email}</th>
      <td>{u.role === "gerant" ? "Gérant" : "Vendeur"}</td>
      <td>{pdv}</td>
      <td>{u.actif ? "Actif" : "Suspendu"}</td>
      <td>
        {u.actif && !confirme
          ? <button type="button" className="danger" onClick={() => setConfirme(true)} aria-label={`Couper l'accès de ${u.email}`}>Couper l'accès</button>
          : null}
        {confirme ? (
          <div className="ligne">
            <span>{u.email} sera déconnecté tout de suite et ne pourra plus se connecter. Action définitive.</span>
            <button type="button" className="danger" onClick={couper} disabled={occupe}>Confirmer la coupure</button>
            <button type="button" className="secondaire" onClick={() => setConfirme(false)}>Annuler</button>
          </div>
        ) : null}
        <Alerte message={erreur} />
      </td>
    </tr>
  );
}

export function PointsDeVente() {
  const pdv = useCharge(() => lire<PointDeVente[]>("/v1/points-de-vente"));
  const users = useCharge(() => lire<Utilisateur[]>("/v1/utilisateurs"));
  const [nom, setNom] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [pdvId, setPdvId] = useState("");
  const [mdp, setMdp] = useState("");
  const a1 = useAction();
  const a2 = useAction();

  const ajouter = (e: FormEvent) => {
    e.preventDefault();
    void a1.lancer(async () => { await envoyer("/v1/points-de-vente", { nom }); setNom(""); pdv.recharger(); return "Point de vente ajouté."; });
  };
  const creer = (e: FormEvent) => {
    e.preventDefault();
    void a2.lancer(async () => {
      await envoyer("/v1/utilisateurs", { email, role, point_of_sale_id: pdvId, mot_de_passe: mdp });
      setEmail(""); setRole(""); setPdvId(""); setMdp(""); users.recharger();
      return "Accès créé. Transmettez le mot de passe provisoire à la personne.";
    });
  };
  const nomPdv = (id: string | null) => pdv.donnees?.find((p) => p.id === id)?.nom ?? "";

  return (
    <Ecran titre="Points de vente et vendeurs">
      <form onSubmit={ajouter} className="carte ligne">
        <Champ libelle="Nom du point de vente" valeur={nom} onChange={setNom} requis />
        <button type="submit" disabled={a1.occupe}>Ajouter le point de vente</button>
      </form>
      <Alerte message={a1.erreur ?? pdv.erreur} />
      <Info message={a1.info} />

      <form onSubmit={creer} className="carte grille">
        <Champ libelle="Adresse e-mail" type="email" valeur={email} onChange={setEmail} requis autoComplete="off" />
        <Choix libelle="Rôle" valeur={role} onChange={setRole} requis options={[{ valeur: "gerant", texte: "Gérant" }, { valeur: "vendeur", texte: "Vendeur" }]} />
        <Choix libelle="Point de vente" valeur={pdvId} onChange={setPdvId} requis options={(pdv.donnees ?? []).map((p) => ({ valeur: p.id, texte: p.nom }))} />
        <Champ libelle="Mot de passe provisoire" type="password" valeur={mdp} onChange={setMdp} requis autoComplete="new-password" aide="10 caractères au moins." />
        <div className="champ"><button type="submit" disabled={a2.occupe}>Créer l'accès</button></div>
      </form>
      <Alerte message={a2.erreur ?? users.erreur} />
      <Info message={a2.info} />

      <section aria-labelledby="titre-pdv">
        <h2 id="titre-pdv">Points de vente</h2>
        {pdv.donnees && pdv.donnees.length === 0 ? <p>Aucun point de vente.</p> : null}
        <ul>{pdv.donnees?.map((p) => <li key={p.id}>{p.nom}</li>)}</ul>
      </section>
      <section aria-labelledby="titre-acces">
        <h2 id="titre-acces">Accès créés</h2>
        {users.donnees && users.donnees.length === 0 ? <p>Aucun gérant ni vendeur.</p> : null}
        {users.donnees && users.donnees.length > 0 ? (
          <table>
            <caption>Gérants et vendeurs</caption>
            <thead><tr><th scope="col">Adresse e-mail</th><th scope="col">Rôle</th><th scope="col">Point de vente</th><th scope="col">État</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {users.donnees.filter((u) => u.role === "gerant" || u.role === "vendeur").map((u) => (
                <AccesLigne key={u.id} u={u} pdv={nomPdv(u.point_of_sale_id)} apres={users.recharger} />
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </Ecran>
  );
}
