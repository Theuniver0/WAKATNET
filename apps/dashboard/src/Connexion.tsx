import { useState, type FormEvent } from "react";
import { envoyer } from "./api.ts";
import { aller } from "./routeur.ts";
import { Alerte, Champ, Ecran, useAction } from "./ui.tsx";

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
    </Ecran>
  );
}

export function Inscription({ apres }: { apres: () => Promise<void> }) {
  const [nom, setNom] = useState("");
  const [email, setEmail] = useState("");
  const [mdp, setMdp] = useState("");
  const { erreur, occupe, lancer } = useAction();
  const envoi = (e: FormEvent) => {
    e.preventDefault();
    void lancer(async () => {
      await envoyer("/v1/inscription", { nom, email, mot_de_passe: mdp }, { sans401: true });
      await apres();
      aller("/");
    });
  };
  return (
    <Ecran titre="Créer un compte">
      <form onSubmit={envoi} className="carte">
        <Champ libelle="Nom de votre zone Wi-Fi" valeur={nom} onChange={setNom} requis autoComplete="organization" />
        <Champ libelle="Adresse e-mail" type="email" valeur={email} onChange={setEmail} requis autoComplete="username" />
        <Champ libelle="Mot de passe" type="password" valeur={mdp} onChange={setMdp} requis autoComplete="new-password"
          aide="10 caractères au moins." />
        <Alerte message={erreur} />
        <button type="submit" disabled={occupe}>Créer mon compte</button>
      </form>
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
