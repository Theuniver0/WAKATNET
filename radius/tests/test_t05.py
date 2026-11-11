"""T3, T12 et épuisement, de bout en bout : accounting rejoué → radius.authorize — ticket 05.

Ticket : .scratch/phase-1-coeur-radius/issues/05-compteurs.md
Décisions de Yacouba (11/11/2026) : temps consommé = SOMME des sessions du ticket ;
forfaits à sens séparés reportés (ADR 0006 §5, amendement du ticket 05).
"""
from conftest import admin, attendre_rejeu, comptabiliser, demander, nouveau_ticket
from test_t04 import _repond, _session_id, sessions

ATTRS_ACCEPT = ("Session-Timeout", "Mikrotik-Rate-Limit", "Port-Limit", "Acct-Interim-Interval")


def _consommer(code: str, *, duree: int = 0, octets: int = 0, statut: str = "Stop", sid: str | None = None) -> str:
    """Session Start puis Interim ou Stop avec les compteurs donnés ; attend le rejeu."""
    sid = sid or _session_id()
    if not any(s["acct_session_id"] == sid for s in sessions(code)):
        _repond(comptabiliser("r1", statut="Start", session_id=sid, utilisateur=code))
    _repond(comptabiliser("r1", statut=statut, session_id=sid, utilisateur=code, duree=duree,
                          octets_entree=octets % 2 ** 32, giga_entree=octets // 2 ** 32, octets_sortie=0))
    attendre_rejeu(lambda: any(s["acct_session_id"] == sid and s["duree_s"] == duree and s["octets_montants"] == octets
                               for s in sessions(code)))
    return sid


def _refus(r, cause):
    assert r is not None and r.nom == "Access-Reject", r and r.attributs
    assert r.un("Reply-Message") == cause
    for attr in ATTRS_ACCEPT:
        assert r.un(attr) is None, attr


def _a_couper(code: str) -> list[tuple]:
    return [(s["acct_session_id"], s["motif_coupure"]) for s in sessions(code) if s["a_couper_le"] is not None]


# --- T3 : temps consommé -----------------------------------------------------

def test_t3_forfait_1h_20_min_consommees_session_timeout_2400():
    code = nouveau_ticket(plan_id=1)
    _consommer(code, duree=1200)
    assert demander("r1", code=code).un("Session-Timeout") == 2400


def test_t3_session_en_cours_compte_jusqu_au_dernier_interim():
    code = nouveau_ticket(plan_id=1)
    _consommer(code, duree=600, statut="Interim-Update")
    assert demander("r1", code=code).un("Session-Timeout") == 3000


def test_temps_epuise_refus_epuise():
    code = nouveau_ticket(plan_id=1)
    _consommer(code, duree=3600)
    _refus(demander("r1", code=code), "epuise")


def test_temps_somme_des_sessions_de_deux_appareils():
    """Décision du 11/11/2026 : les sessions s'additionnent ; le ticket vend 1 h au total."""
    code = nouveau_ticket(plan_id=8)            # 1 h, 2 appareils
    a = _consommer(code, duree=1000, statut="Interim-Update")
    b = _consommer(code, duree=1000, statut="Interim-Update")
    assert demander("r1", code=code).un("Session-Timeout") == 1600
    # Les deux sessions encore ouvertes atteignent ensemble l'heure : toutes deux « à couper ».
    _consommer(code, duree=1800, statut="Interim-Update", sid=a)
    _consommer(code, duree=1800, statut="Interim-Update", sid=b)
    assert sorted(_a_couper(code)) == sorted([(a, "temps_epuise"), (b, "temps_epuise")])
    _refus(demander("r1", code=code), "epuise")


# --- T12 : volume (contrôle côté serveur, ADR 0006 §6) -----------------------

def test_t12_forfait_1_go_900_mo_consommes_accepte_puis_session_a_couper():
    code = nouveau_ticket(plan_id=7)            # 1 Go sur 24 h
    sid = _consommer(code, duree=60, octets=900_000_000, statut="Interim-Update")
    r = demander("r1", code=code)
    assert r.nom == "Access-Accept" and r.un("Session-Timeout") == 86340
    assert _a_couper(code) == []
    # Le reste (100 Mo) est consommé : la session est inscrite « à couper » (Disconnect au ticket 09).
    _consommer(code, duree=120, octets=1_000_000_000, statut="Interim-Update", sid=sid)
    assert _a_couper(code) == [(sid, "volume_epuise")]
    _refus(demander("r1", code=code), "epuise")


def test_volume_epuise_refus_epuise():
    code = nouveau_ticket(plan_id=7)
    _consommer(code, duree=10, octets=1_000_000_001)
    _refus(demander("r1", code=code), "epuise")
    assert _a_couper(code) == []        # session déjà arrêtée : rien à couper


def test_volume_au_dela_de_4_gio_compte():
    code = nouveau_ticket(plan_id=7)
    with admin() as c:
        c.execute("UPDATE app.voucher SET f_data_limit_bytes = 5000000000 WHERE tenant_id = 1 AND code = %s", (code,))
    _consommer(code, duree=10, octets=4_999_999_999, statut="Interim-Update")
    assert demander("r1", code=code).nom == "Access-Accept"
    _consommer(code, duree=20, octets=5_000_000_000, statut="Interim-Update",
               sid=sessions(code)[0]["acct_session_id"])
    _refus(demander("r1", code=code), "epuise")


# --- Copie figée ----------------------------------------------------------

def test_forfait_modifie_apres_la_vente_session_timeout_inchange():
    code = nouveau_ticket(plan_id=1)
    _consommer(code, duree=1200)
    with admin() as c:
        c.execute("UPDATE app.plan SET uptime_limit_s = 60 WHERE id = 1")
    try:
        assert demander("r1", code=code).un("Session-Timeout") == 2400
    finally:
        with admin() as c:
            c.execute("UPDATE app.plan SET uptime_limit_s = 3600 WHERE id = 1")
