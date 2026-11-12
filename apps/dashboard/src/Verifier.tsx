import { useState } from "react";
import { envoyer } from "./api.ts";
import { Alerte, Ecran, Info, useAction } from "./ui.tsx";

/** Lien de vérification de l'adresse (ADR 0017). Le jeton n'est consommé qu'au clic : les antivirus de messagerie
 *  ouvrent les liens, et une simple ouverture ne doit rien valider. Accessible connecté ou non. */
export function Verifier() {
  const jeton = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("j") ?? "";
  const [fait, setFait] = useState(false);
  const { erreur, info, lancer, occupe } = useAction();
  const confirmer = () => void lancer(async () => {
    await envoyer("/v1/verification/confirmer", { jeton }, { sans401: true });
    setFait(true);
    return "Adresse confirmée. Connectez-vous pour continuer.";
  });
  return (
    <Ecran titre="Confirmer votre adresse e-mail">
      {!/^[A-Za-z0-9_-]{43}$/.test(jeton) ? <Alerte message="Ce lien est incomplet : ouvrez-le tel qu'il figure dans l'e-mail." /> : null}
      {!fait ? (
        <button type="button" onClick={confirmer} disabled={occupe || !/^[A-Za-z0-9_-]{43}$/.test(jeton)}>Confirmer mon adresse</button>
      ) : (
        <button type="button" className="secondaire" onClick={() => { window.location.hash = "#/connexion"; window.location.reload(); }}>Se connecter</button>
      )}
      <Alerte message={erreur} />
      <Info message={info} />
    </Ecran>
  );
}
