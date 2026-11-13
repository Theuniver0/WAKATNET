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

/** Brevo (ADR 0019) : API transactionnelle v3. La clé ne quitte jamais l'en-tête ; une erreur ne rapporte que le
 *  code HTTP, jamais le corps (qui pourrait citer l'adresse ou le lien). Délai de 10 s. */
export class ExpediteurBrevo implements Expediteur {
  private readonly r: { cle: string; de: string; nom: string };
  private readonly url: string;
  constructor(r: { cle: string; de: string; nom: string }, url = "https://api.brevo.com/v3/smtp/email") {
    this.r = r;
    this.url = url;
  }
  async envoyer(m: Courriel): Promise<void> {
    const rep = await fetch(this.url, {
      method: "POST",
      headers: { "api-key": this.r.cle, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { email: this.r.de, name: this.r.nom }, to: [{ email: m.a }], subject: m.sujet, textContent: m.texte }),
      signal: AbortSignal.timeout(10_000),
      // Jamais de redirection : l'en-tête api-key la suivrait vers un autre domaine (relecture ADR 0019).
      redirect: "error",
    });
    await rep.body?.cancel();             // corps jamais lu (il pourrait citer l'adresse) : libère la connexion
    if (!rep.ok) throw new Error(`brevo : réponse ${rep.status}`);
  }
}

/** Avis à une adresse déjà inscrite (ADR 0019 : l'inscription répond pareil, l'avis part à la vraie titulaire). */
export function messageAvis(a: string, urlTableau: string): Courriel {
  return {
    a,
    sujet: "WAKATNET : votre adresse a déjà un compte",
    texte: [
      "Bonjour,",
      "",
      "Quelqu'un vient de demander la création d'un compte WAKATNET avec votre adresse, qui en a déjà un. Aucun compte n'a été créé.",
      `Si c'est vous, connectez-vous : ${urlTableau}#/connexion`,
      "Sinon, ignorez ce message.",
    ].join("\n"),
  };
}

/** Avis à une adresse inscrite mais pas encore confirmée. Depuis le scan de sécurité du 13/11/2026 (F2), une nouvelle
 *  demande ne change RIEN au compte : le mot de passe se choisit en confirmant. Aucun lien ici : la titulaire en
 *  demande un depuis l'écran de connexion. Un tiers qui provoque cet avis n'épuise pas les liens du compte. */
export function messageAttente(a: string, urlTableau: string): Courriel {
  return {
    a,
    sujet: "WAKATNET : confirmez votre adresse pour activer votre compte",
    texte: [
      "Bonjour,",
      "",
      "Une demande d'inscription à WAKATNET vient d'être faite avec votre adresse, dont le compte n'est pas encore confirmé.",
      "Rien n'a été modifié : vous choisirez votre mot de passe au moment de confirmer votre adresse.",
      `Si c'est vous, demandez un nouveau lien depuis l'écran de connexion (« Je n'ai pas reçu le lien de confirmation ») : ${urlTableau}#/connexion`,
      "Sinon, ignorez ce message : sans confirmation, le compte est fermé au bout de 7 jours.",
    ].join("\n"),
  };
}

/** Alerte « crédits bas » (SPEC §8.2, migration 0041) : solde sous 20 % du dernier rechargement. Aucune donnée de
 *  client : le solde seul. */
export function messageCreditsBas(a: string, soldeXof: number, urlTableau: string): Courriel {
  return {
    a,
    sujet: "WAKATNET : vos crédits sont bas",
    texte: [
      "Bonjour,",
      "",
      `Le solde de vos crédits WAKATNET est de ${soldeXof.toLocaleString("fr-FR")} F, sous 20 % de votre dernier rechargement.`,
      "Les commissions des ventes en ligne et les frais des tickets papier y sont prélevés. Au-delà du découvert autorisé, la vente en ligne est suspendue.",
      `Rechargez auprès de Telecom Universel, et suivez votre solde ici : ${urlTableau}#/argent`,
    ].join("\n"),
  };
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
