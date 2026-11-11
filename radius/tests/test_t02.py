"""T2 (partie authentification) — un ticket neuf est accepté avec le bon Session-Timeout.

Ticket : .scratch/phase-1-coeur-radius/issues/02-t2-bout-en-bout.md
"""
import os
import subprocess
import tempfile
import time

import pytest

import radlib
from conftest import ROUTEURS, SERVEUR, demander, nouveau_ticket, secret


@pytest.mark.parametrize("methode", ["chap", "pap"])
def test_t2_ticket_neuf_accepte_avec_attributs_de_la_copie_figee(methode):
    code = nouveau_ticket()
    r = demander("r1", code=code, methode=methode)
    assert r is not None, "aucune réponse"
    assert r.nom == "Access-Accept", r.attributs
    assert r.un("Session-Timeout") == 3600
    assert r.un("Mikrotik-Rate-Limit") == "512k/2M"
    assert r.un("Port-Limit") == 1
    assert r.un("Acct-Interim-Interval") == 120
    assert r.un("Message-Authenticator") is not None, "l'Accept doit porter un Message-Authenticator"


def test_pap_insensible_a_la_casse():
    code = nouveau_ticket()
    r = demander("r1", code=code.lower(), methode="pap")
    assert r is not None and r.nom == "Access-Accept"


@pytest.mark.parametrize("methode", ["chap", "pap"])
def test_mauvais_mot_de_passe_donne_ticket_inconnu_sans_attribut_d_accept(methode):
    code = nouveau_ticket()
    r = demander("r1", code=code, mot_de_passe="ZZZZZZZZ", methode=methode)
    assert r is not None and r.nom == "Access-Reject"
    assert r.un("Reply-Message") == "ticket_inconnu"
    assert r.un("Message-Authenticator") is not None, "le Reject doit porter un Message-Authenticator"
    for attr in ("Session-Timeout", "Mikrotik-Rate-Limit", "Port-Limit", "Acct-Interim-Interval"):
        assert r.un(attr) is None, f"{attr} ne doit pas figurer dans un Reject"


def test_reject_sans_delai_artificiel():
    """reject_delay = 0 (ADR 0006 §4) : un Reject doit arriver bien avant le timeout RouterOS (1100 ms)."""
    debut = time.monotonic()
    r = demander("r1", code="ZZZZZZZZ", essais=1, delai=1.0)
    duree = time.monotonic() - debut
    assert r is not None and r.nom == "Access-Reject"
    assert duree < 0.5, f"Reject reçu en {duree:.3f} s"


def test_contre_verification_par_radclient():
    """Même résultat avec radclient 3.2.10 (outil de référence), depuis l'IP de r1."""
    code = nouveau_ticket()
    with tempfile.NamedTemporaryFile("wb", delete=True) as f:
        os.chmod(f.name, 0o600)
        f.write(secret("r1"))
        f.flush()
        requete = f'User-Name = "{code}"\nUser-Password = "{code}"\n'
        sortie = subprocess.run(["radclient", "-x", "-r", "3", "-t", "2", "-S", f.name, f"{SERVEUR}:1812", "auth"],
                                input=requete, capture_output=True, text=True)
    assert "Received Access-Accept" in sortie.stdout, sortie.stdout + sortie.stderr
    assert "Session-Timeout = 3600" in sortie.stdout
