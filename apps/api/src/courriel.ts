// WAKATNET — envoi d'e-mails (ADR 0017 §3) : interface seule. Aucun fournisseur n'est encore choisi ; tant
// qu'il n'y en a pas, la production n'a pas d'expéditeur et l'adresse des propriétaires est validée par le
// super-admin. Brancher un fournisseur = un adaptateur de cette interface, et ses secrets (EnvironmentFile).
// Le corps d'un message contient un lien à usage unique : il n'est JAMAIS journalisé.

export type Courriel = { a: string; sujet: string; texte: string };

export interface Expediteur {
  envoyer(m: Courriel): Promise<void>;
}

/** Tests : garde les messages en mémoire. */
export class ExpediteurMemoire implements Expediteur {
  readonly messages: Courriel[] = [];
  async envoyer(m: Courriel): Promise<void> {
    this.messages.push(m);
  }
}

/** Message de vérification de l'adresse d'un propriétaire. */
export function messageVerification(a: string, lien: string): Courriel {
  return {
    a,
    sujet: "WAKATNET : confirmez votre adresse e-mail",
    texte: [
      "Bonjour,",
      "",
      "Pour confirmer votre adresse et pouvoir raccorder vos routeurs, ouvrez ce lien, puis cliquez sur « Confirmer mon adresse » :",
      lien,
      "",
      "Le lien est valable 24 heures et ne sert qu'une fois. Si vous n'avez pas créé de compte WAKATNET, ignorez ce message.",
    ].join("\n"),
  };
}
