import { useState, type FormEvent } from "react";
import { envoyer } from "./api.ts";
import { Alerte, Champ, Ecran, Info, useAction } from "./ui.tsx";

/** Lien de vérification de l'adresse (ADR 0017). Le jeton n'est consommé qu'à l'envoi du formulaire : les antivirus de
 *  messagerie ouvrent les liens, et une simple ouverture ne doit rien valider. Scan de sécurité du 13/11/2026 (F2) : le
 *  mot de passe se choisit ICI, par le détenteur du lien. Accessible connecté ou non. */
export function Verifier() {
  const jeton = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("j") ?? "";
  const [fait, setFait] = useState(false);
  const [mdp, setMdp] = useState("");
  const [mdp2, setMdp2] = useState("");
  const { erreur, info, lancer, occupe } = useAction();
  const lienValable = /^[A-Za-z0-9_-]{43}$/.test(jeton);
  const confirmer = (e: FormEvent) => {
    e.preventDefault();
    void lancer(async () => {
      if (mdp.length < 10) throw new Error("Mot de passe : 10 caractères au moins.");
      if (mdp !== mdp2) throw new Error("Les deux mots de passe ne sont pas identiques.");
      await envoyer("/v1/verification/confirmer", { jeton, mot_de_passe: mdp }, { sans401: true });
      setFait(true);
      setMdp(""); setMdp2("");
      return "Adresse confirmée et mot de passe enregistré. Connectez-vous pour continuer.";
    });
  };
  return (
    <Ecran titre="Confirmer votre adresse e-mail">
      {!lienValable ? <Alerte message="Ce lien est incomplet : ouvrez-le tel qu'il figure dans l'e-mail." /> : null}
      {!fait ? (
        <form onSubmit={confirmer} className="carte grille">
          <Champ libelle="Choisissez votre mot de passe" type="password" valeur={mdp} onChange={setMdp} requis autoComplete="new-password"
            aide="10 caractères au moins. C'est lui qui servira à vous connecter." />
          <Champ libelle="Retapez le mot de passe" type="password" valeur={mdp2} onChange={setMdp2} requis autoComplete="new-password" />
          <div className="champ"><button type="submit" disabled={occupe || !lienValable}>Confirmer mon adresse</button></div>
        </form>
      ) : (
        <button type="button" className="secondaire" onClick={() => { window.location.hash = "#/connexion"; window.location.reload(); }}>Se connecter</button>
      )}
      <Alerte message={erreur} />
      <Info message={info} />
    </Ecran>
  );
}
