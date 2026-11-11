"""Accounting quand la base est arrêtée, puis figée — ticket 04 (ADR 0008, amendement du ticket 04).

Ticket : .scratch/phase-1-coeur-radius/issues/04-accounting-decouple.md
Ces étapes ne s'exécutent QUE sous l'orchestration de run.sh, qui arrête, fige et relance
PostgreSQL entre deux appels de pytest (le conteneur de test ne pilote pas Docker) :

  a  base en marche   : préparer deux tickets
  b  base ARRÊTÉE     : Start / Interim / Stop du ticket 1 -> réponse immédiate, spool non vide
     (run.sh attend ATTENTE_S secondes, puis relance la base)
  c  base relancée    : rejeu complet, sans perte ni doublon ; activation = instant de RÉCEPTION
  d  base FIGÉE       : (docker compose pause) idem pour le ticket 2
  e  base reprise     : idem

LIMITE MESURÉE (ADR 0006, amendement du ticket 04) : le spool ne dépend pas de la base, mais
la CRÉATION d'un client dynamique (radius.client_lookup) en dépend. Un routeur dont le client
a expiré (lifetime) pendant la panne n'obtient plus aucune réponse, accounting compris : il
bascule sur le nœud B. Les étapes utilisent donc r8 et r9, dont le client vient d'être créé
(étapes a et c), pour prouver que le chemin de l'accounting lui-même ne touche pas la base.

Sans WAKATNET_ETAPE, tous ces tests sont ignorés (passage principal). L'état passe d'une étape
à l'autre par un fichier du conteneur de test, hors dépôt.
"""
import json
import os
import pathlib
import time
import uuid

import pytest

from conftest import admin, attendre_rejeu, comptabiliser, creneau_nouveau_client, demander, nouveau_ticket, spool_vide

ETAT = pathlib.Path("/tmp/wakatnet-t04-indispo.json")
ATTENTE_S = 10   # run.sh attend au moins ce délai entre l'envoi et la relance de la base


def _etape(nom):
    return pytest.mark.skipif(os.environ.get("WAKATNET_ETAPE") != nom, reason="étape orchestrée par run.sh")


def _lire():
    return json.loads(ETAT.read_text())


def _ecrire(etat):
    ETAT.write_text(json.dumps(etat))


def _creer_client(nom: str):
    """Premier paquet du routeur : son client dynamique est créé maintenant (base en marche)."""
    creneau_nouveau_client()
    r = demander(nom, code="ZZZZZZZZ", essais=1)
    assert r is not None and r.un("Reply-Message") == "ticket_inconnu"


def _envoyer(nom: str, code: str) -> dict:
    """Start, Interim, Stop d'une session ; chaque réponse doit être immédiate (règle 2)."""
    sid = uuid.uuid4().hex[:16]
    envoi = time.time()
    for statut, kw in (("Start", {}),
                       ("Interim-Update", dict(octets_entree=300, octets_sortie=700, duree=60)),
                       ("Stop", dict(octets_entree=900, octets_sortie=1500, duree=95, cause_fin=1))):
        debut = time.monotonic()
        r = comptabiliser(nom, statut=statut, session_id=sid, utilisateur=code, essais=1, delai=1.0, **kw)
        assert r is not None and r.nom == "Accounting-Response", f"{statut} : pas de réponse, base indisponible"
        assert time.monotonic() - debut < 0.5, f"{statut} : réponse lente"
    assert not spool_vide(), "les événements doivent attendre dans le spool"
    return {"code": code, "sid": sid, "envoi": envoi}


def _verifier_rejeu(e: dict):
    def sessions():
        with admin() as c:
            return c.execute("""SELECT s.octets_montants, s.octets_descendants, s.duree_s, s.started_at, s.arrete_le
                                 FROM radius.session s JOIN app.voucher v ON v.id = s.voucher_id
                                WHERE v.tenant_id = 1 AND v.code = %s""", (e["code"],)).fetchall()
    attendre_rejeu(lambda: len(sessions()) == 1 and sessions()[0][4] is not None, delai=90)
    rejeu = time.time()
    (montants, descendants, duree, debut, arret), = sessions()     # une seule session : aucun doublon
    assert (montants, descendants, duree) == (900, 1500, 95)       # aucune perte
    with admin() as c:
        active = c.execute("SELECT activated_at FROM app.voucher WHERE tenant_id = 1 AND code = %s",
                           (e["code"],)).fetchone()[0].timestamp()
        n_act = c.execute("""SELECT count(*) FROM radius.activation a JOIN app.voucher v ON v.id = a.voucher_id
                              WHERE v.code = %s""", (e["code"],)).fetchone()[0]
    # Activation à l'instant de RÉCEPTION (envoi), pas à l'instant du rejeu, bien plus tard.
    assert int(e["envoi"]) <= active <= e["envoi"] + 1.5, (e["envoi"], active)
    assert rejeu - active >= ATTENTE_S - 1, "le rejeu aurait dû avoir lieu bien après la réception"
    assert debut.timestamp() == active and n_act == 1


@_etape("a")
def test_a_preparer():
    _ecrire({"tickets": [nouveau_ticket(), nouveau_ticket()]})
    _creer_client("r8")


@_etape("b")
def test_b_base_arretee_accounting_repond_et_attend():
    etat = _lire()
    etat["arretee"] = _envoyer("r8", etat["tickets"][0])
    _ecrire(etat)


@_etape("c")
def test_c_rejeu_complet_apres_relance():
    _verifier_rejeu(_lire()["arretee"])
    _creer_client("r9")


@_etape("d")
def test_d_base_figee_accounting_repond_et_attend():
    etat = _lire()
    etat["figee"] = _envoyer("r9", etat["tickets"][1])
    _ecrire(etat)


@_etape("e")
def test_e_rejeu_complet_apres_reprise():
    _verifier_rejeu(_lire()["figee"])
