"""post_auth et auth_log, appareils simultanés (T5), bind_mac, Accounting-On, T6 journalisé — ticket 06.

Ticket : .scratch/phase-1-coeur-radius/issues/06-sessions.md
Décision de Yacouba du 11/11/2026 : post_auth et auth_log sont livrés ici (avancés du ticket 07),
parce que le compte d'appareils et bind_mac en dépendent (ADR 0006 §9, §10).
"""
import threading
import time

from conftest import ROUTEURS, admin, attendre_rejeu, comptabiliser, demander, nouveau_ticket
from test_t04 import _repond, _session_id, sessions

MAC1, MAC2, MAC3 = "AA-BB-CC-00-06-01", "AA-BB-CC-00-06-02", "aa:bb:cc:00:06:03"


def journal(code: str | None = None, routeur: str | None = None, depuis: int = 0) -> list[dict]:
    with admin() as c:
        cur = c.execute("""SELECT a.*, r.shortname FROM radius.auth_log a LEFT JOIN app.router r ON r.id = a.router_id
                            WHERE a.id > %s
                              AND (%s::text IS NULL OR a.voucher_id = (SELECT id FROM app.voucher WHERE tenant_id = 1 AND code = %s))
                              AND (%s::text IS NULL OR r.shortname = %s)
                            ORDER BY a.id""", (depuis, code, code, routeur, routeur))
        return [dict(zip([d.name for d in cur.description], l)) for l in cur.fetchall()]


def dernier_journal() -> int:
    with admin() as c:
        return c.execute("SELECT coalesce(max(id), 0) FROM radius.auth_log").fetchone()[0]


def vieillir_journal(code: str, secondes: int = 2000) -> None:
    """Forme (d) de l'ADR 0007 : les Accept du ticket sont datés dans le passé (hors fenêtre)."""
    with admin() as c:
        c.execute("""UPDATE radius.auth_log SET at = at - %s * interval '1 second'
                      WHERE voucher_id = (SELECT id FROM app.voucher WHERE tenant_id = 1 AND code = %s)""",
                  (secondes, code))


def _refus(r, cause):
    assert r is not None and r.nom == "Access-Reject", r and r.attributs
    assert r.un("Reply-Message") == cause


# --- post_auth et auth_log (ADR 0006 §10) -------------------------------------

def test_accept_et_reject_journalises_sans_code_en_clair():
    j0 = dernier_journal()
    code = nouveau_ticket()
    assert demander("r1", code=code, calling_station_id=MAC1).nom == "Access-Accept"
    _refus(demander("r1", code=code, mot_de_passe="ZZZZZZZZ", calling_station_id=MAC1), "ticket_inconnu")
    lignes = journal(depuis=j0)
    assert [(l["resultat"], l["cause"], l["shortname"], l["mac"]) for l in lignes] == [
        ("Accept", None, "r1", "AABBCC000601"), ("Reject", "ticket_inconnu", "r1", "AABBCC000601")]
    assert all(l["voucher_id"] == lignes[0]["voucher_id"] is not None for l in lignes)
    # Jamais le code : aucune colonne texte ne le contient.
    assert not any(code in str(v) for l in lignes for v in l.values())


def test_t6_tentative_de_a_sur_un_routeur_de_b_journalisee_sans_ticket():
    """T6, partie « journalisée » : routeur de B, Reject, ticket_inconnu, voucher_id NULL."""
    j0 = dernier_journal()
    code = nouveau_ticket(plan_id=1, tenant_id=1)
    _refus(demander("r7", code=code, calling_station_id=MAC2), "ticket_inconnu")
    lignes = journal(routeur="r7", depuis=j0)
    assert [(l["resultat"], l["cause"], l["voucher_id"], l["tenant_id"]) for l in lignes] == [
        ("Reject", "ticket_inconnu", None, 2)]
    assert not any(code in str(v) for l in lignes for v in l.values())


def test_post_auth_en_echec_l_accept_reste_un_accept():
    """ADR 0006 §10 : l'échec de l'écriture (ici, droit retiré) ne change jamais la réponse."""
    code = nouveau_ticket()
    j0 = dernier_journal()
    with admin() as c:
        c.execute("REVOKE EXECUTE ON FUNCTION radius.post_auth(text, text, text, text, text) FROM wk_radius")
    try:
        r = demander("r1", code=code, calling_station_id=MAC1)
        assert r.nom == "Access-Accept" and r.un("Session-Timeout") == 3600
        _refus(demander("r1", code="ZZZZZZZZ", calling_station_id=MAC1), "ticket_inconnu")
    finally:
        with admin() as c:
            c.execute("GRANT EXECUTE ON FUNCTION radius.post_auth(text, text, text, text, text) TO wk_radius")
    assert journal(depuis=j0) == []


# --- T5 : appareils simultanés (ADR 0006 §9) ---------------------------------

def test_t5_second_appareil_refuse_avant_tout_start():
    """Course de l'ADR : deux Access-Request depuis deux routeurs, avant tout Start. Le second voit
    l'Accept du premier dans auth_log (écrit avant la réponse) : refusé. La course résiduelle (deux
    requêtes à moins d'un aller-retour) est documentée dans l'ADR 0006, amendement du ticket 06."""
    code = nouveau_ticket(plan_id=1)            # 1 appareil
    assert demander("r1", code=code, calling_station_id=MAC1).nom == "Access-Accept"
    _refus(demander("r2", code=code, calling_station_id=MAC2), "trop_d_appareils")
    # Le même appareil se reconnecte (même MAC, autre écriture) : accepté.
    assert demander("r1", code=code, calling_station_id=MAC1.replace("-", ":").lower()).nom == "Access-Accept"


def test_t5_session_ouverte_compte_puis_libere_la_place_a_l_arret():
    code, sid = nouveau_ticket(plan_id=1), _session_id()
    assert demander("r1", code=code, calling_station_id=MAC1).nom == "Access-Accept"
    _repond(comptabiliser("r1", statut="Start", session_id=sid, utilisateur=code, calling_station_id=MAC1))
    attendre_rejeu(lambda: len(sessions(code)) == 1)
    vieillir_journal(code)                       # l'Accept sort de la fenêtre ; la session ouverte reste
    _refus(demander("r2", code=code, calling_station_id=MAC2), "trop_d_appareils")
    _repond(comptabiliser("r1", statut="Stop", session_id=sid, utilisateur=code, calling_station_id=MAC1, duree=30))
    attendre_rejeu(lambda: sessions(code)[0]["arrete_le"] is not None)
    vieillir_journal(code)
    assert demander("r2", code=code, calling_station_id=MAC2).nom == "Access-Accept"


def test_t5_deux_appareils_permis_le_troisieme_refuse():
    code = nouveau_ticket(plan_id=8)            # 2 appareils
    assert demander("r1", code=code, calling_station_id=MAC1).nom == "Access-Accept"
    assert demander("r2", code=code, calling_station_id=MAC2).nom == "Access-Accept"
    _refus(demander("r1", code=code, calling_station_id=MAC3), "trop_d_appareils")


def test_t5_course_residuelle_requetes_simultanees_documentee():
    """ADR 0006, amendement du ticket 06 : deux Access-Request SIMULTANÉS (moins d'un aller-retour)
    peuvent tous deux être acceptés ; c'est la limite assumée. Ce test fixe les bornes de ce
    comportement : jamais de silence ni d'erreur, au moins un Accept, au plus deux, et le
    troisième appareil, arrivé après les réponses, est toujours refusé."""
    code = nouveau_ticket(plan_id=1)
    reponses = {}
    depart = threading.Barrier(2)

    def envoyer(nom, mac):
        depart.wait()
        reponses[mac] = demander(nom, code=code, calling_station_id=mac, essais=1, delai=2.0)

    fils = [threading.Thread(target=envoyer, args=a) for a in (("r1", MAC1), ("r2", MAC2))]
    for f in fils:
        f.start()
    for f in fils:
        f.join()
    noms = sorted(r.nom for r in reponses.values() if r is not None)
    assert len(noms) == 2, "silence : aucune requête ne doit rester sans réponse"
    assert noms.count("Access-Accept") in (1, 2)
    _refus(demander("r1", code=code, calling_station_id=MAC3), "trop_d_appareils")


# --- bind_mac --------------------------------------------------------------

def test_bind_mac_premier_appareil_lie_second_refuse_premier_de_nouveau_accepte():
    code = nouveau_ticket(plan_id=9)
    assert demander("r1", code=code, calling_station_id=MAC1).nom == "Access-Accept"
    with admin() as c:
        assert c.execute("SELECT mac_liee FROM app.voucher WHERE tenant_id = 1 AND code = %s",
                         (code,)).fetchone() == ("AABBCC000601",)
    vieillir_journal(code)                       # même hors fenêtre, la liaison tient
    _refus(demander("r2", code=code, calling_station_id=MAC2), "trop_d_appareils")
    assert demander("r2", code=code, calling_station_id=MAC1).nom == "Access-Accept"


# --- Accounting-On (ADR 0006 §8) --------------------------------------------

def test_accounting_on_ferme_les_sessions_et_change_d_epoque():
    code, sid = nouveau_ticket(plan_id=8), _session_id()
    _repond(comptabiliser("r2", statut="Start", session_id=sid, utilisateur=code))
    _repond(comptabiliser("r2", statut="Interim-Update", session_id=sid, utilisateur=code, duree=300))
    attendre_rejeu(lambda: len(sessions(code)) == 1 and sessions(code)[0]["duree_s"] == 300)
    with admin() as c:
        epoque = c.execute("SELECT epoch FROM app.router WHERE shortname = 'r2'").fetchone()[0]
    time.sleep(1.1)   # instants de réception à la seconde : le On est postérieur au Start
    _repond(comptabiliser("r2", statut="Accounting-On", session_id=_session_id(), framed_ip=None))
    attendre_rejeu(lambda: sessions(code)[0]["arrete_le"] is not None)
    s = sessions(code)[0]
    assert (s["cause_fin"], s["duree_s"]) == ("Accounting-On", 300)   # temps consommé conservé
    with admin() as c:
        assert c.execute("SELECT epoch FROM app.router WHERE shortname = 'r2'").fetchone()[0] == epoque + 1
    # Acct-Session-Id réutilisé après le redémarrage : nouvelle session distincte, ouverte.
    _repond(comptabiliser("r2", statut="Start", session_id=sid, utilisateur=code))
    attendre_rejeu(lambda: len(sessions(code)) == 2)
    assert sessions(code)[1]["arrete_le"] is None and sessions(code)[1]["router_epoch"] == epoque + 1
