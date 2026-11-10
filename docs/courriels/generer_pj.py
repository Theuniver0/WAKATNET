#!/usr/bin/env python3
"""Génère, pour chaque agrégateur, la pièce jointe du courriel : questionnaire Word (.docx).

Contenu = §2 (questions générales) + la section propre au prestataire du §3 de
docs/QUESTIONS_AGREGATEURS.md. Rejeu : python3 docs/courriels/generer_pj.py
Exige pandoc. Les .docx produits vont dans docs/courriels/pj/.
"""
import pathlib
import re
import subprocess
import sys

ICI = pathlib.Path(__file__).resolve().parent
SOURCE = ICI.parent / "QUESTIONS_AGREGATEURS.md"
SORTIE = ICI / "pj"
CIBLES = {  # fichier -> (titre de section du §3, nom affiché)
    "pawapay": ("### 3.1 pawaPay", "pawaPay (Kerry Payments Burkina)"),
    "cinetpay": ("### 3.2 CinetPay", "CinetPay"),
    "yengapay": ("### 3.3 YengaPay", "YengaPay (Kreezus)"),
}


def section(texte, debut, fin_regex):
    i = texte.index(debut)
    m = re.compile(fin_regex, re.M).search(texte, i + len(debut))
    return texte[i:m.start() if m else len(texte)].rstrip()


def main():
    texte = SOURCE.read_text(encoding="utf-8")
    generales = section(texte, "## 2. Questions générales", r"^## 3\.")
    # « - a. » (puce + lettre) donnait un tiret parasite dans Word : on garde la seule liste lettrée.
    generales = re.sub(r"^(\s+)- ([a-z])\. ", r"\1\2. ", generales, flags=re.M)
    SORTIE.mkdir(exist_ok=True)
    for cle, (titre, nom) in CIBLES.items():
        propres = section(texte, titre, r"^### 3\.\d|^## 4\.")
        propres = propres.replace(titre, f"## Questions propres à {nom}", 1)
        # Une question par paragraphe : dans la source, P1., C1., Y1. ne sont séparées que par un saut de ligne.
        propres = re.sub(r"\n(?=[A-Z]\d+\. )", "\n\n", propres)
        md = (
            f"# WAKATNET — Questionnaire d'intégration Mobile Money\n\n"
            f"**Destinataire :** {nom}  \n**Émetteur :** Telecom Universel, Ouagadougou  \n"
            f"**Date :** 10/11/2026\n\n"
            "Merci de répondre par écrit, question par question, en joignant si possible les liens "
            "vers votre documentation officielle et vos conditions tarifaires. La question 40 "
            "indique l'ordre de priorité si vous ne pouvez pas tout traiter rapidement.\n\n"
            f"{generales}\n\n{propres}\n"
        )
        md = re.sub(r"^## 2\. Questions générales.*$", "## Questions générales", md, count=1, flags=re.M)
        tmp = SORTIE / f"{cle}.md"
        tmp.write_text(md, encoding="utf-8")
        docx = SORTIE / f"WAKATNET-questionnaire-{cle}.docx"
        subprocess.run(["pandoc", str(tmp), "-o", str(docx)], check=True)
        tmp.unlink()
        print(f"écrit : {docx.relative_to(ICI.parent.parent)}")


if __name__ == "__main__":
    sys.exit(main())
