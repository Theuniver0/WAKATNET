// WAKATNET — création d'un super-admin, À LA MAIN sur le nœud (ADR 0014 §3).
//   printf '%s\n%s\n' ADRESSE MOT_DE_PASSE | node src/admin-creer.ts
// Le mot de passe est lu sur l'entrée standard, jamais en argument (S1). Connexion par
// WAKATNET_ADMIN_DATABASE_URL (rôle d'administration de la base : aucun rôle de connexion de
// l'application ne peut créer de super-admin) ; clé de chiffrement : WAKATNET_CLE_MARCHANDS.
// Affiche UNE fois l'URI otpauth:// à scanner dans l'application d'authentification.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { base32Encoder, chiffrerTotp, hacher, mdpAcceptable } from "./auth.ts";
import { lireCle } from "./chiffrement.ts";

const lignes: string[] = [];
for await (const morceau of process.stdin) lignes.push(...String(morceau).split("\n"));
const [email, mdp] = [lignes[0]?.trim().toLowerCase() ?? "", lignes[1] ?? ""];
if (!/^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,24}$/.test(email) || !mdpAcceptable(mdp)) {
  console.error("entrée : adresse puis mot de passe (10 caractères au moins), une ligne chacun");
  process.exit(1);
}
const url = process.env.WAKATNET_ADMIN_DATABASE_URL;
if (!url) { console.error("WAKATNET_ADMIN_DATABASE_URL manquant"); process.exit(1); }
const cle = lireCle(process.env.WAKATNET_CLE_MARCHANDS, "WAKATNET_CLE_MARCHANDS", 32);
const secret = randomBytes(20);
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const r = await c.query("SELECT app.super_admin_creer($1, $2, $3) AS id", [email, await hacher(mdp), chiffrerTotp(cle, email, secret)]);
  console.log(`super-admin créé (utilisateur ${r.rows[0].id}).`);
  console.log(`À scanner une seule fois : otpauth://totp/WAKATNET:${encodeURIComponent(email)}?secret=${base32Encoder(secret)}&issuer=WAKATNET&digits=6&period=30`);
} finally {
  await c.end();
}
