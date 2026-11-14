// WAKATNET — PDF minimal, écrit à la main (ADR 0014 §6) : PDF 1.4, polices standard Helvetica et
// Helvetica-Bold (aucune police embarquée), encodage WinAnsi (accents français), texte et cadres.
// Ticket : .scratch/phase-4-exploitation/issues/04-lots-pdf.md
//
// Coordonnées en points (1/72 de pouce), origine en HAUT à gauche pour l'appelant ; converties
// vers l'origine PDF (bas à gauche) ici. A4 = 595 × 842 points.

export const A4 = { largeur: 595, hauteur: 842 };

/** Unicode → octet WinAnsi (CP1252) ; un caractère hors table devient « ? ». */
const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

export function winAnsi(s: string): Buffer {
  const out: number[] = [];
  for (const ch of s.normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    if (c === 0x202f || c === 0x00a0) out.push(0x20);                 // espaces insécables → espace
    else if (c >= 0x20 && c <= 0x7e) out.push(c);
    else if (c >= 0xa0 && c <= 0xff) out.push(c);
    else if (CP1252[c] !== undefined) out.push(CP1252[c]);
    else out.push(0x3f);
  }
  return Buffer.from(out);
}

/** Chaîne PDF littérale : ( ) et \ échappés ; octets hors ASCII en octal. */
function chaine(s: string): string {
  let r = "(";
  for (const b of winAnsi(s)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) r += "\\" + String.fromCharCode(b);
    else if (b < 0x20 || b > 0x7e) r += "\\" + b.toString(8).padStart(3, "0");
    else r += String.fromCharCode(b);
  }
  return r + ")";
}

const n = (x: number) => (Math.round(x * 100) / 100).toString();

// Chasses de Helvetica (AFM standard d'Adobe), en millièmes d'em, de l'espace (0x20) au tilde (0x7e).
const CHASSES = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

function chasse(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (c >= 0x20 && c <= 0x7e) return CHASSES[c - 0x20];
  const b = ch.normalize("NFD")[0];                                  // é → e, À → A
  const cb = b.codePointAt(0)!;
  if (b !== ch && cb >= 0x20 && cb <= 0x7e) return CHASSES[cb - 0x20];
  return 1000;                                                       // œ, €, … : majorant
}

/** Largeur d'un texte en Helvetica, en points. Majorant pour le gras (écart AFM ≤ 0,06 em par
 *  caractère) : sert à couper et à tronquer sans jamais déborder d'un cadre. */
export function largeur(s: string, taille: number, gras = false): number {
  let m = 0;
  for (const ch of s.normalize("NFC")) m += chasse(ch) + (gras ? 60 : 0);
  return (m * taille) / 1000;
}

export class Pdf {
  private pages: string[] = [];
  private courante: string[] | null = null;

  page(): this {
    this.courante = [];
    this.pages.push("");
    return this;
  }

  private ecrire(op: string) {
    if (this.courante === null) this.page();
    this.courante!.push(op);
    this.pages[this.pages.length - 1] = this.courante!.join("\n");
  }

  texte(x: number, y: number, taille: number, s: string, gras = false): this {
    this.ecrire(`BT /${gras ? "F2" : "F1"} ${n(taille)} Tf ${n(x)} ${n(A4.hauteur - y)} Td ${chaine(s)} Tj ET`);
    return this;
  }

  texteDroite(xDroite: number, y: number, taille: number, s: string, gras = false): this {
    return this.texte(xDroite - largeur(s, taille, gras), y, taille, s, gras);
  }

  texteCentre(xCentre: number, y: number, taille: number, s: string, gras = false): this {
    return this.texte(xCentre - largeur(s, taille, gras) / 2, y, taille, s, gras);
  }

  /** Cadre (y = bord haut), trait de 0,5 pt, pointillé possible (lignes de découpe). */
  cadre(x: number, y: number, l: number, h: number, pointille = false): this {
    this.ecrire(`${pointille ? "[3 3] 0 d" : "[] 0 d"} 0.5 w ${n(x)} ${n(A4.hauteur - y - h)} ${n(l)} ${n(h)} re S`);
    return this;
  }

  trait(x1: number, y1: number, x2: number, y2: number): this {
    this.ecrire(`[] 0 d 0.5 w ${n(x1)} ${n(A4.hauteur - y1)} m ${n(x2)} ${n(A4.hauteur - y2)} l S`);
    return this;
  }

  /** Document complet. Tables de références croisées exactes (décalages en octets). */
  octets(): Buffer {
    if (this.pages.length === 0) this.page();
    const objets: Buffer[] = [];
    const np = this.pages.length;
    // 1 catalogue, 2 arbre des pages, 3 et 4 polices, puis (page, contenu) par page.
    objets.push(Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"));
    const kids = this.pages.map((_, i) => `${5 + 2 * i} 0 R`).join(" ");
    objets.push(Buffer.from(`<< /Type /Pages /Count ${np} /Kids [${kids}] >>`));
    objets.push(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"));
    objets.push(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"));
    this.pages.forEach((contenu, i) => {
      objets.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.largeur} ${A4.hauteur}] `
        + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`));
      const flux = Buffer.from(contenu, "latin1");
      objets.push(Buffer.concat([Buffer.from(`<< /Length ${flux.length} >>\nstream\n`), flux, Buffer.from("\nendstream")]));
    });
    const morceaux: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let pos = morceaux[0].length;
    const decalages: number[] = [];
    objets.forEach((o, i) => {
      decalages.push(pos);
      const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from("\nendobj\n")]);
      morceaux.push(b);
      pos += b.length;
    });
    const xref = [`xref\n0 ${objets.length + 1}\n0000000000 65535 f \n`,
      ...decalages.map((d) => `${d.toString().padStart(10, "0")} 00000 n \n`),
      `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`].join("");
    morceaux.push(Buffer.from(xref, "latin1"));
    return Buffer.concat(morceaux);
  }
}

/** Montant XOF lisible : « 1 500 F » (espace fine ASCII pour WinAnsi). */
export function franc(x: bigint | number): string {
  const s = BigInt(x).toString();
  const neg = s.startsWith("-");
  const d = neg ? s.slice(1) : s;
  return `${neg ? "-" : ""}${d.replace(/\B(?=(\d{3})+(?!\d))/g, " ")} F`;
}

export function dureeLisible(s: number | null): string {
  if (!s) return "";
  if (s % 86400 === 0) return `${s / 86400} jour${s >= 172800 ? "s" : ""}`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  return `${Math.round(s / 60)} min`;
}

/** Découpe un texte en lignes d'au plus `max` points (mots entiers ; un mot trop long est coupé). */
export function couper(s: string, taille: number, max: number, gras = false): string[] {
  const lignes: string[] = [];
  let courante = "";
  for (const mot of s.split(/\s+/).filter(Boolean)) {
    const essai = courante ? `${courante} ${mot}` : mot;
    if (largeur(essai, taille, gras) <= max) { courante = essai; continue; }
    if (courante) lignes.push(courante);
    let reste = mot;
    while (largeur(reste, taille, gras) > max) {
      let n = reste.length - 1;
      while (n > 1 && largeur(reste.slice(0, n), taille, gras) > max) n--;
      lignes.push(reste.slice(0, n));
      reste = reste.slice(n);
    }
    courante = reste;
  }
  if (courante) lignes.push(courante);
  return lignes;
}

/** Une seule ligne d'au plus `max` points, tronquée par « … » au besoin. Une seule passe, linéaire en la longueur
 *  de `s` (scan de sécurité du 13/11/2026, F1 : l'ancienne boucle remesurait toute la chaîne à chaque caractère retiré,
 *  O(n²) sur la boucle d'événements ; une zone de milliers de caractères bloquait l'API). Un texte plus long que
 *  TRONQUER_MAX est d'abord coupé : aucune ligne d'un PDF n'en affiche autant. */
const TRONQUER_MAX = 1000;
export function tronquer(s: string, taille: number, max: number, gras = false): string {
  const borne = s.length > TRONQUER_MAX ? s.slice(0, TRONQUER_MAX) : s;
  if (borne === s && largeur(s, taille, gras) <= max) return s;
  const limite = max - largeur("…", taille, gras);
  let t = "", w = 0;
  for (const ch of borne.normalize("NFC")) {
    const c = largeur(ch, taille, gras);
    if (w + c > limite && t.length > 0) break;
    t += ch;
    w += c;
  }
  return `${t.trimEnd()}…`;
}

export type TicketPapier = { code: string; plan: string; prix: bigint; uptime: number | null; validite: number | null };

/** Planche de tickets : 10 par page A4 (2 colonnes × 5 rangées), traits de découpe pointillés. */
export function planche(tickets: TicketPapier[], zone: string, pdv: string): Buffer {
  const pdf = new Pdf();
  const marge = 28, l = (A4.largeur - 2 * marge) / 2, h = (A4.hauteur - 2 * marge) / 5;
  const enTete = tronquer(zone, 11, l - 28, true);                    // une fois par lot, pas une fois par ticket (F1)
  tickets.forEach((t, i) => {
    if (i % 10 === 0) pdf.page();
    const col = i % 2, rang = Math.floor((i % 10) / 2);
    const x = marge + col * l, y = marge + rang * h;
    pdf.cadre(x, y, l, h, true);
    const utile = l - 28;                                              // marges intérieures : rien ne déborde
    pdf.texte(x + 14, y + 22, 11, enTete, true);
    pdf.texte(x + 14, y + 38, 9, tronquer(`${t.plan} - ${franc(t.prix)}`, 9, utile));
    pdf.texteCentre(x + l / 2, y + 86, 26, t.code, true);
    const d = [t.uptime ? `${dureeLisible(t.uptime)} de connexion` : "", t.validite ? `valable ${dureeLisible(t.validite)}` : ""]
      .filter(Boolean).join(", ");
    pdf.texte(x + 14, y + 110, 9, tronquer(d, 9, utile));
    const pied = [...couper("Connectez-vous au Wi-Fi, puis saisissez ce code.", 8, utile), ...couper(`Point de vente : ${pdv}`, 8, utile)];
    pied.slice(0, 3).forEach((s, k) => pdf.texte(x + 14, y + 124 + 10 * k, 8, k === 2 && pied.length > 3 ? tronquer(`${s} ${pied.slice(3).join(" ")}`, 8, utile) : s));
  });
  return pdf.octets();
}
