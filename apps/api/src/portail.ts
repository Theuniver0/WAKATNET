// WAKATNET — portail captif (SPEC §7.1, §7.2 ; ADR 0005 §1 ; ADR 0013 §9, §10).
// Ticket : .scratch/phase-3-portail-paiement/issues/06-portail.md
//
// HTML rendu côté serveur, CSS en ligne, aucune ressource externe, moins de 100 Ko par page.
// Fonctionne sans JavaScript (rechargement par <meta refresh>) ; un petit script en ligne
// interroge l'état toutes les 3 s pendant 3 min au plus. Textes courts, gros boutons, en français.
// Le mot « RADIUS » n'apparaît jamais (SPEC §0).
import { randomBytes, createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { normaliserNumero, type Operateur } from "../../../packages/payments/src/index.ts";
import type { Base } from "./base.ts";
import { hmacNumero } from "./chiffrement.ts";
import { estIdentifiant } from "./identifiant.ts";
import type { ServicePaiement } from "./paiement.ts";
import { cleSource } from "./cle-ip.ts";

const SITE = /^[A-Za-z0-9_-]{16}$/;
const REFERENCE = /^wk_[A-Za-z0-9_-]{22}$/;
const SOUMISSION = /^[A-Za-z0-9_-]{16,64}$/;
const COOKIE = "wk_app";

// ------------------------------------------------------------------ utilitaires HTML
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const CSS = `body{margin:0;font:18px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f1ea;color:#1d1d1b}
main{max-width:26rem;margin:0 auto;padding:1rem}h1{font-size:1.35rem;margin:.5rem 0}p{margin:.5rem 0}
.carte{background:#fff;border-radius:.75rem;padding:1rem;margin:.75rem 0;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.btn{display:block;width:100%;box-sizing:border-box;margin:.6rem 0;padding:.9rem;border:0;border-radius:.6rem;background:#b5651d;color:#fff;
font-size:1.1rem;text-align:center;text-decoration:none}.btn.sec{background:#fff;color:#b5651d;border:2px solid #b5651d}
input{box-sizing:border-box;width:100%;font-size:1.25rem;padding:.6rem;border:2px solid #bbb;border-radius:.5rem;margin:.25rem 0 .6rem}
label{font-weight:600}.erreur{color:#a40000;font-weight:600}.code{font:700 2rem/1.2 ui-monospace,monospace;letter-spacing:.15em;text-align:center}
.petit{font-size:.9rem;color:#555}fieldset{border:0;padding:0;margin:0}.choix{display:block;padding:.6rem;border:2px solid #ddd;border-radius:.5rem;margin:.4rem 0}`;

function page(titre: string, corps: string, extraTete = ""): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${esc(titre)}</title><style>${CSS}</style>${extraTete}</head><body><main>${corps}</main></body></html>`;
}

function envoyer(rep: FastifyReply, html: string, code = 200) {
  return rep.code(code).type("text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .header("content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; form-action 'self' http: https:; frame-ancestors 'none'; base-uri 'none'")
    .header("referrer-policy", "no-referrer")
    .send(html);
}

// ------------------------------------------------------------------ contexte du hotspot
/** Paramètres transmis par la page de redirection du routeur, conservés de page en page. */
type Contexte = { l: string; o: string };

function contexte(q: Record<string, unknown>): Contexte {
  const v = (k: string) => (typeof q[k] === "string" ? (q[k] as string).slice(0, 512) : "");
  return { l: v("l") || v("link-login-only"), o: v("o") || v("link-orig") };
}

function suffixe(c: Contexte, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({ ...(c.l ? { l: c.l } : {}), ...(c.o ? { o: c.o } : {}), ...extra });
  const s = p.toString();
  return s ? `?${s}` : "";
}

function champsCaches(c: Contexte): string {
  return (c.l ? `<input type="hidden" name="l" value="${esc(c.l)}">` : "") + (c.o ? `<input type="hidden" name="o" value="${esc(c.o)}">` : "");
}

/**
 * Lien d'auto-connexion (ADR 0013 §10, relecture argent I1) : GET vers link-login-only avec le code.
 * La cible doit être http(s), sans identifiants, et son hôte doit figurer parmi les hôtes de
 * connexion du hotspot relevés à l'enrôlement (adresse et nom DNS des profils). Toute autre cible,
 * y compris une IP privée quelconque (un autre client du même Wi-Fi), est refusée : le code
 * n'est alors qu'affiché.
 */
export function lienConnexion(lien: string, hotesSite: string[], code: string, origine = ""): string | null {
  let u: URL;
  try { u = new URL(lien); } catch { return null; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return null;
  // La page de connexion du hotspot, et rien d'autre du même hôte (revue : un autre port ou un autre
  // chemin du routeur recevrait le code). Port par défaut, sauf si l'hôte enregistré le précise.
  const hotes = hotesSite.map((h) => h.toLowerCase());
  const ok = u.port === "" ? hotes.includes(u.hostname.toLowerCase()) : hotes.includes(u.host.toLowerCase());
  if (!ok || u.pathname !== "/login") return null;
  u.search = "";
  u.hash = "";
  u.searchParams.set("username", code);
  u.searchParams.set("password", code);
  try {
    const d = new URL(origine);
    if (d.protocol === "http:" || d.protocol === "https:") u.searchParams.set("dst", d.toString());
  } catch { /* pas de destination d'origine */ }
  return u.toString();
}

/** Causes de refus du serveur (ADR 0006 §4) → messages utiles (§7.1). */
const MESSAGES: [RegExp, string][] = [
  [/epuise/, "Forfait terminé : achetez-en un nouveau."],
  [/expire/, "Ticket expiré : achetez un nouveau forfait."],
  [/ticket_inconnu/, "Code inconnu : vérifiez le code de votre ticket."],
  [/trop_d_appareils/, "Ce ticket est déjà utilisé sur le nombre d'appareils permis."],
  [/mauvais_site/, "Ce ticket n'est pas valable dans cette zone Wi-Fi."],
  [/trop_de_tentatives/, "Trop d'essais : patientez quelques minutes."],
  [/proprietaire_suspendu/, "Cette zone Wi-Fi est momentanément indisponible."],
];

export function messageErreur(e: string): string | null {
  if (!e) return null;
  for (const [m, t] of MESSAGES) if (m.test(e)) return t;
  return "La connexion a échoué. Réessayez.";
}

function duree(s: number | null): string {
  if (!s) return "";
  if (s % 86400 === 0) return `${s / 86400} jour${s >= 172800 ? "s" : ""}`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  return `${Math.round(s / 60)} min`;
}

// ------------------------------------------------------------------ jeton d'appareil
function lireCookie(req: FastifyRequest): Buffer | null {
  const c = req.headers.cookie ?? "";
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(c);
  return m ? Buffer.from(m[1], "base64url") : null;
}

/** Le jeton reste sur l'appareil ; la base n'en garde que l'empreinte (ADR 0005 §1). */
function jetonAppareil(req: FastifyRequest, rep: FastifyReply): Buffer {
  let j = lireCookie(req);
  if (j === null || j.length !== 32) {
    j = randomBytes(32);
    rep.header("set-cookie", `${COOKIE}=${j.toString("base64url")}; Path=/p; Max-Age=86400; HttpOnly; SameSite=Lax; Secure`);
  }
  return j;
}
const empreinte = (j: Buffer) => createHash("sha256").update(j).digest();

// ------------------------------------------------------------------ routes
type Site = { site_id: bigint; tenant_id: bigint; site_nom: string; hotspot_hotes: string[]; vente: string };

const MODELE_REDIRECTION = new URL("../../../routeros/hotspot/redirection.html", import.meta.url);

/** Page de redirection du routeur vers le portail, pour un site (ticket 06). */
export async function redirection(urlPortail: string, publicId: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  if (!/^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(urlPortail) || !SITE.test(publicId)) throw new Error("redirection : valeurs invalides");
  return (await readFile(MODELE_REDIRECTION, "utf8")).replaceAll("__PORTAIL__", urlPortail).replaceAll("__SITE__", publicId);
}

export function routesPortail(app: FastifyInstance, base: Base, service: ServicePaiement | null, cleHmac: Buffer | null): void {
  app.register(async (p) => {
    p.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 4096 },
      (_req, corps, fait) => fait(null, Object.fromEntries(new URLSearchParams(corps as string))));

    async function site(id: string): Promise<Site | null> {
      if (!SITE.test(id)) return null;
      const [s] = await base.$queryRaw<Site[]>`SELECT site_id, tenant_id, site_nom, hotspot_hotes, vente FROM app.portail_site(${id})`;
      return s ?? null;
    }
    const introuvable = (rep: FastifyReply) => envoyer(rep, page("Introuvable", `<h1>Zone Wi-Fi inconnue</h1>`), 404);

    // Accueil : « J'ai un ticket » ou « Acheter un forfait ».
    p.get<{ Params: { site: string }; Querystring: Record<string, string> }>("/p/:site", async (req, rep) => {
      const s = await site(req.params.site);
      if (!s) return introuvable(rep);
      const c = contexte(req.query);
      const err = messageErreur(typeof req.query.error === "string" ? req.query.error : "");
      // P6 : un achat de cet appareil dans les 24 h → proposé d'emblée.
      const j = lireCookie(req);
      let enCours = "";
      if (j) {
        const [d] = await base.$queryRaw<{ reference: string; statut: string }[]>`
          SELECT reference, statut FROM app.paiement_par_jeton(${req.params.site}, ${empreinte(j)})`;
        if (d && ["SUCCEEDED", "PENDING", "CREATED", "EXPIRED"].includes(d.statut)) {
          enCours = `<div class="carte"><p>${d.statut === "SUCCEEDED" ? "Votre ticket est prêt." : "Votre achat est en cours."}</p>`
            + `<a class="btn" href="/p/${esc(req.params.site)}/achat/${esc(d.reference)}${esc(suffixe(c))}">Voir mon achat</a></div>`;
        }
      }
      const vente = s.vente === "ok"
        ? `<a class="btn" href="/p/${esc(req.params.site)}/forfaits${esc(suffixe(c))}">Acheter du temps de connexion</a>`
        : `<p class="petit">L'achat en ligne est momentanément indisponible ici.</p>`;
      return envoyer(rep, page(s.site_nom, `<h1>${esc(s.site_nom)}</h1>${err ? `<p class="erreur">${esc(err)}</p>` : ""}${enCours}
<div class="carte"><form method="post" action="/p/${esc(req.params.site)}/ticket">${champsCaches(c)}
<label for="code">J'ai un ticket</label><input id="code" name="code" maxlength="32" autocomplete="off" autocapitalize="characters" required>
<button class="btn" type="submit">Se connecter</button></form></div>
<div class="carte">${vente}<a class="btn sec" href="/p/${esc(req.params.site)}/retrouver${esc(suffixe(c))}">J'ai payé mais je n'ai pas mon ticket</a></div>`));
    });

    // « J'ai un ticket » : connexion au hotspot par le lien du routeur.
    p.post<{ Params: { site: string }; Body: Record<string, string> }>("/p/:site/ticket", async (req, rep) => {
      const s = await site(req.params.site);
      if (!s) return introuvable(rep);
      const c = contexte(req.body ?? {});
      const code = String(req.body?.code ?? "").replace(/\s+/g, "").toUpperCase();
      if (!/^[0-9A-Z]{4,32}$/.test(code)) {
        return rep.redirect(`/p/${req.params.site}${suffixe(c, { error: "ticket_inconnu" })}`, 303);
      }
      const lien = lienConnexion(c.l, s.hotspot_hotes, code, c.o);
      if (lien) return rep.redirect(lien, 303);
      return envoyer(rep, page("Connexion", `<h1>Connexion</h1><p>Ouvrez la page de connexion du Wi-Fi et saisissez :</p><p class="code">${esc(code)}</p>`));
    });

    // Forfaits proposés.
    p.get<{ Params: { site: string }; Querystring: Record<string, string> }>("/p/:site/forfaits", async (req, rep) => {
      const s = await site(req.params.site);
      if (!s) return introuvable(rep);
      const c = contexte(req.query);
      const f = await base.$queryRaw<{ plan_id: bigint; nom: string; prix_xof: bigint; uptime_limit_s: number | null;
                                        validity_s: number | null; devices: number }[]>`
        SELECT plan_id, nom, prix_xof, uptime_limit_s, validity_s, devices FROM app.portail_forfaits(${req.params.site})`;
      const liste = f.length === 0 ? `<p>Aucun forfait en vente ici pour le moment.</p>` : f.map((x) => {
        const d = [x.uptime_limit_s ? `${duree(x.uptime_limit_s)} de connexion` : "", x.validity_s ? `valable ${duree(x.validity_s)}` : ""]
          .filter(Boolean).join(", ");
        return `<a class="btn" href="/p/${esc(req.params.site)}/payer${esc(suffixe(c, { plan: x.plan_id.toString() }))}">${esc(x.nom)} — ${x.prix_xof} F<br><span class="petit" style="color:#fff">${esc(d)}</span></a>`;
      }).join("");
      return envoyer(rep, page("Forfaits", `<h1>Choisissez votre forfait</h1>${s.vente === "ok" ? liste : "<p>L'achat en ligne est momentanément indisponible ici.</p>"}
<a class="btn sec" href="/p/${esc(req.params.site)}${esc(suffixe(c))}">Retour</a>`));
    });

    // Formulaire de paiement (une clé de soumission par affichage : P9).
    function formulaire(id: string, c: Contexte, plan: { plan_id: bigint; nom: string; prix_xof: bigint }, erreur = ""): string {
      const ussd = `*144*4*6*${plan.prix_xof}#`;
      return page("Paiement", `<h1>${esc(plan.nom)} — ${plan.prix_xof} F</h1>${erreur ? `<p class="erreur">${esc(erreur)}</p>` : ""}
<form method="post" action="/p/${esc(id)}/payer">${champsCaches(c)}
<input type="hidden" name="plan" value="${plan.plan_id}"><input type="hidden" name="soumission" value="${randomBytes(18).toString("base64url")}">
<fieldset><label class="choix"><input type="radio" name="operateur" value="orange_bf" required style="width:auto"> Orange Money</label>
<p class="petit">Composez d'abord <a href="tel:${esc(ussd.replace("#", "%23"))}"><b>${esc(ussd)}</b></a>, puis saisissez le code reçu.</p>
<label class="choix"><input type="radio" name="operateur" value="moov_bf" style="width:auto"> Moov Money</label>
<p class="petit">Vous validerez le paiement sur votre téléphone.</p></fieldset>
<label for="numero">Votre numéro</label><input id="numero" name="numero" inputmode="tel" maxlength="16" required>
<label for="otp">Code reçu (Orange Money)</label><input id="otp" name="otp" inputmode="numeric" maxlength="8" autocomplete="one-time-code">
<button class="btn" type="submit">Payer ${plan.prix_xof} F</button></form>
<a class="btn sec" href="/p/${esc(id)}/forfaits${esc(suffixe(c))}">Retour</a>`);
    }

    async function forfait(id: string, planId: unknown) {
      if (!estIdentifiant(planId)) return null;
      const [x] = await base.$queryRaw<{ plan_id: bigint; nom: string; prix_xof: bigint }[]>`
        SELECT plan_id, nom, prix_xof FROM app.portail_forfaits(${id}) WHERE plan_id = ${BigInt(planId)}`;
      return x ?? null;
    }

    p.get<{ Params: { site: string }; Querystring: Record<string, string> }>("/p/:site/payer", async (req, rep) => {
      const s = await site(req.params.site);
      if (!s) return introuvable(rep);
      const c = contexte(req.query);
      const plan = await forfait(req.params.site, req.query.plan);
      if (!plan) return rep.redirect(`/p/${req.params.site}/forfaits${suffixe(c)}`, 303);
      jetonAppareil(req, rep);
      return envoyer(rep, formulaire(req.params.site, c, plan));
    });

    p.post<{ Params: { site: string }; Body: Record<string, string> }>("/p/:site/payer", async (req, rep) => {
      const s = await site(req.params.site);
      if (!s) return introuvable(rep);
      const b = req.body ?? {};
      const c = contexte(b);
      const plan = await forfait(req.params.site, b.plan);
      if (!plan) return rep.redirect(`/p/${req.params.site}/forfaits${suffixe(c)}`, 303);
      if (service === null) return envoyer(rep, formulaire(req.params.site, c, plan, "Paiement momentanément indisponible."), 503);
      const op = b.operateur === "orange_bf" || b.operateur === "moov_bf" ? (b.operateur as Operateur) : null;
      const otp = String(b.otp ?? "").trim();
      if (!op) return envoyer(rep, formulaire(req.params.site, c, plan, "Choisissez Orange Money ou Moov Money."), 422);
      if (op === "orange_bf" && !/^[0-9]{4,8}$/.test(otp)) {
        return envoyer(rep, formulaire(req.params.site, c, plan, "Saisissez le code reçu après avoir composé le code Orange Money."), 422);
      }
      if (!SOUMISSION.test(String(b.soumission ?? ""))) return envoyer(rep, formulaire(req.params.site, c, plan, "Formulaire expiré : recommencez."), 422);
      const r = await service.creer({ sitePublic: req.params.site, planId: plan.plan_id, operateur: op, numero: String(b.numero ?? ""),
                                      otp: op === "orange_bf" ? otp : undefined, jetonAppareil: empreinte(jetonAppareil(req, rep)),
                                      soumission: String(b.soumission), source: cleSource(req.ip, cleHmac) });
      if (r.statut === "numero_invalide") return envoyer(rep, formulaire(req.params.site, c, plan, "Numéro invalide : 8 chiffres."), 422);
      if (r.statut === "trop_de_demandes") {
        return envoyer(rep, formulaire(req.params.site, c, plan, "Trop de demandes pour ce numéro : patientez quelques minutes."), 429);
      }
      if (r.statut !== "cree" && r.statut !== "deja") {
        return envoyer(rep, formulaire(req.params.site, c, plan, "L'achat en ligne est momentanément indisponible ici."), 409);
      }
      const extra: Record<string, string> = "message" in r && r.message ? { m: r.message === "paiement refusé par l'opérateur" ? "refus" : "panne" } : {};
      return rep.redirect(`/p/${req.params.site}/achat/${r.reference}${suffixe(c, extra)}`, 303);
    });

    // Suivi d'un achat : attente, ticket et auto-connexion, ou échec.
    p.get<{ Params: { site: string; ref: string }; Querystring: Record<string, string> }>("/p/:site/achat/:ref", async (req, rep) => {
      const s = await site(req.params.site);
      if (!s || !REFERENCE.test(req.params.ref)) return introuvable(rep);
      const c = contexte(req.query);
      const j = lireCookie(req);
      const [e] = await base.$queryRaw<{ statut: string; code: string | null }[]>`
        SELECT statut, code FROM app.paiement_etat(${req.params.site}, ${req.params.ref}, ${j ? empreinte(j) : Buffer.alloc(32)})`;
      if (!e) return introuvable(rep);
      const ici = `/p/${esc(req.params.site)}/achat/${esc(req.params.ref)}${esc(suffixe(c))}`;
      if (e.statut === "SUCCEEDED" && e.code) {
        const lien = lienConnexion(c.l, s.hotspot_hotes, e.code, c.o);
        const tete = lien ? `<meta http-equiv="refresh" content="3;url=${esc(lien)}">` : "";
        return envoyer(rep, page("Votre ticket", `<h1>Paiement reçu</h1><p>Votre code :</p><p class="code">${esc(e.code)}</p>
${lien ? `<a class="btn" href="${esc(lien)}">Se connecter maintenant</a><p class="petit">Connexion automatique dans quelques secondes.</p>`
        : `<p class="petit">Gardez ce code : saisissez-le sur la page de connexion du Wi-Fi.</p>`}`, tete));
      }
      if (e.statut === "SUCCEEDED") {
        return envoyer(rep, page("Ticket", `<h1>Paiement reçu</h1><p>Ce ticket a été acheté depuis un autre appareil.</p>
<a class="btn" href="/p/${esc(req.params.site)}/retrouver${esc(suffixe(c))}">Retrouver mon ticket</a>`));
      }
      if (e.statut === "MISMATCH") {
        // Le fournisseur a confirmé un débit d'un AUTRE montant : ni ticket, ni « rien facturé » (revue).
        return envoyer(rep, page("Paiement en vérification", `<h1>Paiement en vérification</h1><p>Le montant reçu ne correspond pas au forfait. Aucun ticket n'a été créé ; le gérant de la zone Wi-Fi va vérifier. Gardez le SMS de votre opérateur.</p>
<a class="btn sec" href="/p/${esc(req.params.site)}${esc(suffixe(c))}">Retour</a>`));
      }
      if (e.statut === "FAILED") {
        return envoyer(rep, page("Paiement non abouti", `<h1>Paiement non abouti</h1><p>L'opérateur n'a pas confirmé ce paiement. Si vous avez tout de même été débité, revenez sur cette page : le ticket apparaîtra dès sa confirmation.</p>
<a class="btn" href="/p/${esc(req.params.site)}/forfaits${esc(suffixe(c))}">Réessayer</a><a class="btn sec" href="${ici}">Actualiser</a>`));
      }
      const panne = req.query.m === "panne" ? `<p class="erreur">Le service de paiement ne répond pas. Patientez ou réessayez dans quelques minutes.</p>` : "";
      if (e.statut === "EXPIRED") {
        return envoyer(rep, page("En attente", `<h1>Paiement non confirmé</h1>${panne}<p>Si vous avez payé, votre ticket apparaîtra ici dès la confirmation de l'opérateur. Revenez sur cette page.</p>
<a class="btn" href="${ici}">Actualiser</a><a class="btn sec" href="/p/${esc(req.params.site)}/forfaits${esc(suffixe(c))}">Nouvel achat</a>`));
      }
      // CREATED ou PENDING : attente, interrogation toutes les 3 s pendant 3 min (§7.2).
      const etat = `/p/${req.params.site}/etat/${req.params.ref}`;
      return envoyer(rep, page("En attente", `<h1>Validez le paiement</h1>${panne}<p>Validez sur votre téléphone. Cette page se met à jour toute seule.</p>
<a class="btn sec" href="${ici}">Actualiser</a>
<script>var n=0,t=setInterval(function(){if(++n>60){clearInterval(t);return}var x=new XMLHttpRequest();x.open("GET",${JSON.stringify(etat)});
x.onload=function(){try{var r=JSON.parse(x.responseText);if(r.statut!=="CREATED"&&r.statut!=="PENDING"){clearInterval(t);location.reload()}}catch(e){}};x.send()},3000)</script>`,
        `<noscript><meta http-equiv="refresh" content="5"></noscript>`));
    });

    // État en JSON pour le script d'attente (jamais le code).
    p.get<{ Params: { site: string; ref: string } }>("/p/:site/etat/:ref", async (req, rep) => {
      if (!SITE.test(req.params.site) || !REFERENCE.test(req.params.ref)) return rep.code(404).send({ statut: "inconnu" });
      const [e] = await base.$queryRaw<{ statut: string }[]>`SELECT statut FROM app.paiement_etat(${req.params.site}, ${req.params.ref}, ${Buffer.alloc(32)})`;
      return rep.header("cache-control", "no-store").send({ statut: e?.statut ?? "inconnu" });
    });

    // Retrouver un achat : numéro + 4 derniers caractères de la référence reçue par SMS (ADR 0005 §1).
    const formRetrouver = (id: string, c: Contexte, msg = "") => page("Retrouver mon ticket", `<h1>Retrouver mon ticket</h1>
${msg ? `<p class="erreur">${esc(msg)}</p>` : ""}<form method="post" action="/p/${esc(id)}/retrouver">${champsCaches(c)}
<label for="numero">Numéro qui a payé</label><input id="numero" name="numero" inputmode="tel" maxlength="16" required>
<label for="ref">4 derniers caractères de la référence reçue par SMS</label><input id="ref" name="suffixe" maxlength="4" autocapitalize="characters" required>
<button class="btn" type="submit">Retrouver</button></form><a class="btn sec" href="/p/${esc(id)}${esc(suffixe(c))}">Retour</a>`);

    p.get<{ Params: { site: string }; Querystring: Record<string, string> }>("/p/:site/retrouver", async (req, rep) => {
      if (!(await site(req.params.site))) return introuvable(rep);
      jetonAppareil(req, rep);
      return envoyer(rep, formRetrouver(req.params.site, contexte(req.query)));
    });

    p.post<{ Params: { site: string }; Body: Record<string, string> }>("/p/:site/retrouver", async (req, rep) => {
      if (!(await site(req.params.site))) return introuvable(rep);
      const c = contexte(req.body ?? {});
      if (cleHmac === null) return envoyer(rep, formRetrouver(req.params.site, c, "Service momentanément indisponible."), 503);
      const numero = normaliserNumero(String(req.body?.numero ?? ""));
      const suf = String(req.body?.suffixe ?? "").trim();
      if (numero === null || !/^[A-Za-z0-9]{4}$/.test(suf)) return envoyer(rep, formRetrouver(req.params.site, c, "Numéro (8 chiffres) et 4 caractères attendus."), 422);
      const [r] = await base.$queryRaw<{ statut: string; reference: string | null }[]>`
        SELECT statut, reference FROM app.paiement_retrouver(${req.params.site}, ${hmacNumero(cleHmac, numero)}, ${suf},
                                                            ${empreinte(jetonAppareil(req, rep))})`;
      if (r.statut === "trouve") return rep.redirect(`/p/${req.params.site}/achat/${r.reference}${suffixe(c)}`, 303);
      if (r.statut === "trop_de_tentatives") return envoyer(rep, formRetrouver(req.params.site, c, "Trop d'essais : patientez 15 minutes."), 429);
      return envoyer(rep, formRetrouver(req.params.site, c, "Aucun achat trouvé avec ces informations."), 404);
    });
  });
}
