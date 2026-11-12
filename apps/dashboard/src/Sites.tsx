import { useState, type FormEvent } from "react";
import { envoyer, lire, type Routeur, type Site } from "./api.ts";
import { dateHeure } from "./format.ts";
import { Alerte, Champ, Ecran, Info, useAction, useCharge } from "./ui.tsx";

type Commande = { commande: string; expire_le: string };

function SiteLigne({ site }: { site: Site }) {
  const [cmd, setCmd] = useState<Commande | null>(null);
  const { erreur, info, lancer, occupe } = useAction();
  const raccorder = () => void lancer(async () => { setCmd(await envoyer<Commande>(`/v1/sites/${site.id}/enrollments`)); });
  const copier = () => void lancer(async () => {
    if (!cmd) return;
    await navigator.clipboard.writeText(cmd.commande);
    return "Commande copiée.";
  });
  return (
    <li className="carte">
      <h3>{site.nom}</h3>
      <p className="ligne">
        <button type="button" onClick={raccorder} disabled={occupe}>Raccorder un routeur</button>
        <a className="bouton" href={`/v1/sites/${site.id}/redirection.html`} download="login.html">Page de connexion du hotspot</a>
      </p>
      <Alerte message={erreur} />
      {cmd ? (
        <>
          <p>Collez cette commande dans le terminal de votre routeur MikroTik. Elle expire le {dateHeure(cmd.expire_le)} (heure du Burkina) et ne sert qu'une fois.</p>
          <pre tabIndex={0}>{cmd.commande}</pre>
          <button type="button" onClick={copier}>Copier</button>
        </>
      ) : null}
      <Info message={info} />
    </li>
  );
}

function RouteurLigne({ r, site, apres }: { r: Routeur; site: string; apres: () => void }) {
  const [confirme, setConfirme] = useState(false);
  const { erreur, lancer, occupe } = useAction();
  const revoquer = () => void lancer(async () => { await envoyer(`/v1/routers/${r.id}/revoke`); setConfirme(false); apres(); });
  return (
    <tr>
      <th scope="row">{r.nom}</th>
      <td>{site}</td>
      <td>{r.actif ? "Actif" : "Révoqué"}</td>
      <td>{dateHeure(r.enrole_le)}</td>
      <td>
        <div className="ligne">
          <a href={`/v1/routers/${r.id}/uninstall.rsc`} download>Script de désinstallation</a>
          {r.actif && !confirme ? <button type="button" className="danger" onClick={() => setConfirme(true)}>Révoquer</button> : null}
        </div>
        {confirme ? (
          <div className="ligne">
            <span>Ce routeur ne pourra plus vendre. Action définitive.</span>
            <button type="button" className="danger" onClick={revoquer} disabled={occupe}>Confirmer la révocation</button>
            <button type="button" className="secondaire" onClick={() => setConfirme(false)}>Annuler</button>
          </div>
        ) : null}
        <Alerte message={erreur} />
      </td>
    </tr>
  );
}

export function Sites() {
  const [nom, setNom] = useState("");
  const sites = useCharge(() => lire<Site[]>("/v1/sites"));
  const routeurs = useCharge(() => lire<Routeur[]>("/v1/routers"));
  const { erreur, info, lancer, occupe } = useAction();
  const ajouter = (e: FormEvent) => {
    e.preventDefault();
    void lancer(async () => { await envoyer("/v1/sites", { nom }); setNom(""); sites.recharger(); return "Site ajouté."; });
  };
  const nomSite = (id: string) => sites.donnees?.find((s) => s.id === id)?.nom ?? `Site ${id}`;
  return (
    <Ecran titre="Sites et routeurs">
      <form onSubmit={ajouter} className="carte ligne">
        <Champ libelle="Nom du site" valeur={nom} onChange={setNom} requis />
        <button type="submit" disabled={occupe}>Ajouter le site</button>
      </form>
      <Alerte message={erreur ?? sites.erreur} />
      <Info message={info} />
      <section aria-labelledby="titre-sites">
        <h2 id="titre-sites">Vos sites</h2>
        {sites.donnees && sites.donnees.length === 0 ? <p>Aucun site pour l'instant. Ajoutez votre premier site ci-dessus.</p> : null}
        <ul className="liste">{sites.donnees?.map((s) => <SiteLigne key={s.id} site={s} />)}</ul>
      </section>
      <section aria-labelledby="titre-routeurs">
        <h2 id="titre-routeurs">Vos routeurs</h2>
        <Alerte message={routeurs.erreur} />
        {routeurs.donnees && routeurs.donnees.length === 0 ? <p>Aucun routeur raccordé.</p> : null}
        {routeurs.donnees && routeurs.donnees.length > 0 ? (
          <table>
            <caption>Routeurs raccordés</caption>
            <thead><tr><th scope="col">Routeur</th><th scope="col">Site</th><th scope="col">État</th><th scope="col">Raccordé le</th><th scope="col">Actions</th></tr></thead>
            <tbody>{routeurs.donnees.map((r) => <RouteurLigne key={r.id} r={r} site={nomSite(r.site_id)} apres={routeurs.recharger} />)}</tbody>
          </table>
        ) : null}
      </section>
    </Ecran>
  );
}
