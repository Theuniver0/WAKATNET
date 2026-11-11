"""Accounting découplé de bout en bout : routeur → FreeRADIUS (detail) → lecteur → radius.acct_*.

Ticket : .scratch/phase-1-coeur-radius/issues/04-accounting-decouple.md
Contrats : ADR 0006 §7 (horloges), §8 (idempotence, compteurs, activation), §12 (lecteur).
Le spool est observé en lecture seule (conftest.SPOOL) ; « detail vidé » = conftest.attendre_rejeu.
"""
import time
import uuid

from conftest import admin, attendre_rejeu, comptabiliser, demander, nouveau_ticket

GIO4 = 2 ** 32


def _session_id() -> str:
    return uuid.uuid4().hex[:16].upper()


def sessions(code: str, tenant: int = 1) -> list[dict]:
    with admin() as c:
        cur = c.execute("""SELECT s.* FROM radius.session s JOIN app.voucher v ON v.id = s.voucher_id
                            WHERE v.tenant_id = %s AND v.code = %s ORDER BY s.id""", (tenant, code))
        noms = [d.name for d in cur.description]
        return [dict(zip(noms, ligne)) for ligne in cur.fetchall()]


COMPTEURS = ("id", "started_at", "octets_montants", "octets_descendants", "duree_s", "arrete_le", "cause_fin")


def compteurs(code: str) -> list[tuple]:
    """Ce que T7 fige : compteurs, fermeture. (dernier_evenement_le avance à chaque réception.)"""
    return [tuple(s[k] for k in COMPTEURS) for s in sessions(code)]


def ticket(code: str, tenant: int = 1) -> dict:
    with admin() as c:
        cur = c.execute("SELECT * FROM app.voucher WHERE tenant_id = %s AND code = %s", (tenant, code))
        return dict(zip([d.name for d in cur.description], cur.fetchone()))


def activations(code: str, tenant: int = 1) -> list[tuple]:
    with admin() as c:
        return c.execute("""SELECT a.active_le FROM radius.activation a JOIN app.voucher v ON v.id = a.voucher_id
                             WHERE v.tenant_id = %s AND v.code = %s""", (tenant, code)).fetchall()


def quarantaine_depuis(id_min: int) -> list[tuple]:
    with admin() as c:
        return c.execute("SELECT fonction, motif FROM radius.acct_quarantaine WHERE id > %s ORDER BY id",
                         (id_min,)).fetchall()


def dernier_id_quarantaine() -> int:
    with admin() as c:
        return c.execute("SELECT coalesce(max(id), 0) FROM radius.acct_quarantaine").fetchone()[0]


def _repond(r):
    assert r is not None, "aucune Accounting-Response"
    assert r.nom == "Accounting-Response", r.nom


# --- Réponse immédiate (règle 2, C3) --------------------------------------

def test_accounting_repond_immediatement_sans_attendre_la_base():
    """La section accounting n'écrit que le fichier detail : réponse en quelques ms."""
    code = nouveau_ticket()
    debut = time.monotonic()
    _repond(comptabiliser("r1", statut="Start", session_id=_session_id(), utilisateur=code, essais=1, delai=1.0))
    assert time.monotonic() - debut < 0.5


# --- Activation (T2, ADR 0006 §7, §8) -------------------------------------

def test_activation_au_premier_start_a_l_instant_de_reception_jamais_l_heure_du_routeur():
    code = nouveau_ticket(plan_id=4)
    avant = time.time()
    # Horloge du routeur fausse de 30 jours (coupure de courant) : jamais utilisée (C4).
    _repond(comptabiliser("r1", statut="Start", session_id=_session_id(), utilisateur=code,
                          event_timestamp=int(avant) - 30 * 86400))
    apres = time.time()
    attendre_rejeu(lambda: ticket(code)["activated_at"] is not None)
    active = ticket(code)["activated_at"].timestamp()
    # Instant de réception, à la seconde (Packet-Original-Timestamp est un entier de secondes).
    assert int(avant) <= active <= apres + 1, (avant, active, apres)
    assert [a[0].timestamp() for a in activations(code)] == [active]

    # Second Start (autre session) : l'activation ne bouge pas, un seul événement.
    time.sleep(1.1)
    _repond(comptabiliser("r1", statut="Start", session_id=_session_id(), utilisateur=code))
    attendre_rejeu(lambda: len(sessions(code)) == 2)
    assert ticket(code)["activated_at"].timestamp() == active
    assert len(activations(code)) == 1


def test_t2_activation_demarre_la_validite_du_forfait():
    """Accept → Start → la validité court : le login suivant reçoit moins que la validité entière."""
    code = nouveau_ticket(plan_id=4)            # validité 5 h
    assert demander("r1", code=code).un("Session-Timeout") == 18000
    _repond(comptabiliser("r1", statut="Start", session_id=_session_id(), utilisateur=code))
    attendre_rejeu(lambda: ticket(code)["activated_at"] is not None)
    time.sleep(2.1)
    st = demander("r1", code=code).un("Session-Timeout")
    assert 17995 <= st <= 17998, st


def test_start_perdu_l_interim_cree_la_session_et_active():
    code = nouveau_ticket()
    avant = time.time()
    _repond(comptabiliser("r1", statut="Interim-Update", session_id=_session_id(), utilisateur=code,
                          octets_entree=100, octets_sortie=200, duree=120))
    attendre_rejeu(lambda: len(sessions(code)) == 1)
    s = sessions(code)[0]
    assert (s["octets_montants"], s["octets_descendants"], s["duree_s"]) == (100, 200, 120)
    assert int(avant) <= ticket(code)["activated_at"].timestamp() <= time.time() + 1


# --- T7 et compteurs -------------------------------------------------------

def test_t7_stop_recu_deux_fois_compteurs_inchanges():
    code, sid = nouveau_ticket(), _session_id()
    _repond(comptabiliser("r1", statut="Start", session_id=sid, utilisateur=code))
    _repond(comptabiliser("r1", statut="Interim-Update", session_id=sid, utilisateur=code,
                          octets_entree=1000, octets_sortie=2000, duree=60))
    stop = dict(statut="Stop", session_id=sid, utilisateur=code, octets_entree=5000, octets_sortie=9000,
                duree=180, cause_fin=1)
    _repond(comptabiliser("r1", **stop))
    attendre_rejeu(lambda: sessions(code) and sessions(code)[0]["arrete_le"] is not None)
    premier = compteurs(code)

    _repond(comptabiliser("r1", **stop))     # retransmission du même Stop
    attendre_rejeu()
    assert compteurs(code) == premier

    # Interim retardé (valeurs plus anciennes) après le Stop : rien ne recule, rien ne rouvre.
    _repond(comptabiliser("r1", statut="Interim-Update", session_id=sid, utilisateur=code,
                          octets_entree=1000, octets_sortie=2000, duree=60))
    attendre_rejeu()
    assert compteurs(code) == premier
    s = sessions(code)[0]
    assert (s["octets_montants"], s["octets_descendants"], s["duree_s"]) == (5000, 9000, 180)
    assert s["cause_fin"] == "User-Request"


def test_gigawords_au_dela_de_4_gio():
    code, sid = nouveau_ticket(), _session_id()
    _repond(comptabiliser("r1", statut="Start", session_id=sid, utilisateur=code))
    _repond(comptabiliser("r1", statut="Interim-Update", session_id=sid, utilisateur=code,
                          octets_entree=7, giga_entree=1, octets_sortie=5, giga_sortie=3, duree=600))
    attendre_rejeu(lambda: sessions(code) and sessions(code)[0]["duree_s"] == 600)
    s = sessions(code)[0]
    # Sens par défaut (radius.parametre, non vérifié sur CHR) : Acct-Input = montant (client → routeur).
    assert (s["octets_montants"], s["octets_descendants"]) == (GIO4 + 7, 3 * GIO4 + 5)


def test_meme_acct_session_id_sur_deux_routeurs_deux_sessions():
    code, sid = nouveau_ticket(), _session_id()
    _repond(comptabiliser("r1", statut="Start", session_id=sid, utilisateur=code))
    _repond(comptabiliser("r2", statut="Start", session_id=sid, utilisateur=code))
    attendre_rejeu(lambda: len(sessions(code)) == 2)


# --- Enregistrement empoisonné et types non traités --------------------------

def test_enregistrement_empoisonne_au_milieu_mis_en_quarantaine_les_suivants_passent():
    q0 = dernier_id_quarantaine()
    a, b = nouveau_ticket(), nouveau_ticket()
    _repond(comptabiliser("r1", statut="Start", session_id=_session_id(), utilisateur=a))
    _repond(comptabiliser("r1", statut="Interim-Update", session_id=_session_id(), utilisateur="X" * 70,
                          octets_entree=1, octets_sortie=1, duree=1))
    _repond(comptabiliser("r1", statut="Start", session_id=_session_id(), utilisateur="ZZZZZZZZ"))
    _repond(comptabiliser("r1", statut="Start", session_id=_session_id(), utilisateur=b))
    attendre_rejeu(lambda: len(sessions(a)) == 1 and len(sessions(b)) == 1)
    assert quarantaine_depuis(q0) == [("acct_interim", "utilisateur_invalide"), ("acct_start", "ticket_inconnu")]


def test_accounting_on_acquitte_sans_bloquer_la_file():
    """Accounting-On/Off : traités au ticket 06. D'ici là, acquittés sans effet, sans bloquer le rejeu."""
    _repond(comptabiliser("r2", statut="Accounting-On", session_id=_session_id(), framed_ip=None))
    code = nouveau_ticket()
    _repond(comptabiliser("r2", statut="Start", session_id=_session_id(), utilisateur=code))
    attendre_rejeu(lambda: len(sessions(code)) == 1)
