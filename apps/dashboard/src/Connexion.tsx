import { useState, type FormEvent } from "react";
import { envoyer } from "./api.ts";
import { aller } from "./routeur.ts";
import { Alerte, Champ, Ecran, Info, useAction } from "./ui.tsx";

/** Lien de confirmation perdu (ADR 0019) : renvoi sans session, réponse toujours identique. */
function Renvoi() {
  const [email, setEmail] = useState("");
  const { erreur, info, occupe, lancer } = useAction();
  const envoi = (e: FormEvent) => {
    e.preventDefault();
    void lancer(async () => {
      const r = await envoyer<{ message: string }>("/v1/verification/renvoyer", { email }, { sans401: true });
      return r.message;
    });
  };
  return (
    <details className="carte">
      <summary>Je n'ai pas reçu le lien de confirmation</summary>
      <form onSubmit={envoi}>
        <Champ libelle="Adresse e-mail du compte" type="email" valeur={email} onChange={setEmail} requis autoComplete="username" />
        <button type="submit" className="secondaire" disabled={occupe}>Renvoyer le lien</button>
      </form>
      <Alerte message={erreur} />
      <Info message={info} />
    </details>
  );
}

export function Connexion({ apres }: { apres: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [mdp, setMdp] = useState("");
  const { erreur, occupe, lancer } = useAction();
  const envoi = (e: FormEvent) => {
    e.preventDefault();
    void lancer(async () => {
      await envoyer("/v1/connexion", { email, mot_de_passe: mdp }, { sans401: true });
      await apres();
      aller("/");
    });
  };
  return (
    <Ecran titre="Connexion">
      <form onSubmit={envoi} className="carte">
        <Champ libelle="Adresse e-mail" type="email" valeur={email} onChange={setEmail} requis autoComplete="username" />
        <Champ libelle="Mot de passe" type="password" valeur={mdp} onChange={setMdp} requis autoComplete="current-password" />
        <Alerte message={erreur} />
        <button type="submit" disabled={occupe}>Se connecter</button>
      </form>
      <p><a href="#/inscription">Créer un compte</a></p>
      <Renvoi />
    </Ecran>
  );
}

// ADR 0019 : l'inscription n'ouvre pas de session et répond pareil que l'adresse soit libre ou non (F9). La suite :
// le lien reçu par e-mail, puis la connexion.
export function Inscription(_props: { apres: () => Promise<void> }) {
  const [nom, setNom] = useState("");
  const [email, setEmail] = useState("");
  const { erreur, info, occupe, lancer } = useAction();
  const envoi = (e: FormEvent) => {
    e.preventDefault();
    void lancer(async () => {
      const r = await envoyer<{ message: string }>("/v1/inscription", { nom, email }, { sans401: true });
      return r.message;
    });
  };
  return (
    <Ecran titre="Créer un compte">
      <form onSubmit={envoi} className="carte">
        <Champ libelle="Nom de votre zone Wi-Fi" valeur={nom} onChange={setNom} requis autoComplete="organization" />
        <Champ libelle="Adresse e-mail" type="email" valeur={email} onChange={setEmail} requis autoComplete="username" />
        <p>Vous choisirez votre mot de passe en ouvrant le lien de confirmation reçu par e-mail.</p>
        <Alerte message={erreur} />
        <button type="submit" disabled={occupe}>Créer mon compte</button>
      </form>
      <Info message={info} />
      <p><a href="#/connexion">J'ai déjà un compte</a></p>
    </Ecran>
  );
}

export function Totp({ apres }: { apres: () => Promise<void> }) {
  const [code, setCode] = useState("");
  const { erreur, occupe, lancer } = useAction();
  const envoi = (e: FormEvent) => {
    e.preventDefault();
    void lancer(async () => {
      await envoyer("/v1/totp", { code });
      await apres();
      aller("/admin");
    });
  };
  return (
    <Ecran titre="Vérification en deux étapes">
      <form onSubmit={envoi} className="carte">
        <Champ libelle="Code de vérification" valeur={code} onChange={setCode} requis autoComplete="one-time-code" inputMode="numeric" />
        <Alerte message={erreur} />
        <button type="submit" disabled={occupe}>Valider</button>
      </form>
    </Ecran>
  );
}
