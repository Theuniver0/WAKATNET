"""Anti-devinette sous attaque — suite de la mesure du ticket 10 (RAPPORT.md §7, migration 0012).

Ticket : .scratch/phase-1-coeur-radius/issues/10-performance.md
Mesuré au ticket 10 : sous attaque (beaucoup d'échecs récents sur un routeur, MAC toutes
différentes) et avec des statistiques non rafraîchies, la recherche des échecs d'UNE MAC passait
par l'index PAR ROUTEUR et filtrait la MAC : 44 ms par authorize à 100 000 échecs récents.
Corrigé structurellement : l'index par routeur porte sur (router_id + 0), qu'une condition
« router_id = … » ne peut pas utiliser. Ces tests le prouvent par les compteurs d'index de
PostgreSQL, sans dépendre d'une durée.
"""
import uuid

from conftest import ROUTEURS, admin, en_tant_que_radius, en_tant_que_test, nouveau_ticket

R5 = ROUTEURS["r5"][0]   # routeur réservé aux essais en base (tickets 03 et 07)
INDEX_ROUTEUR = "auth_log_echecs_routeur"


def _parcours(c, index: str) -> int:
    c.execute("SELECT pg_stat_force_next_flush()")
    return c.execute("SELECT coalesce(sum(idx_scan), 0) FROM pg_stat_user_indexes WHERE indexrelname = %s",
                     (index,)).fetchone()[0]


def _attaque(n: int) -> None:
    """n échecs ticket_inconnu récents sur r5, chacun d'une MAC différente, SANS ANALYZE."""
    with admin() as c:
        c.execute("""INSERT INTO radius.auth_log (at, router_id, tenant_id, mac, resultat, cause)
                     SELECT now() - random() * interval '4 minutes', r.id, r.tenant_id,
                            '02FA' || lpad(to_hex(g), 8, '0'), 'Reject', 'ticket_inconnu'
                       FROM app.router r, generate_series(1, %s) g WHERE r.overlay_ip = %s""", (n, R5))


def _nettoyer() -> None:
    with admin() as c:
        c.execute("DELETE FROM radius.auth_log WHERE mac LIKE '02FA%'")


def test_authorize_d_un_vrai_client_n_utilise_jamais_l_index_par_routeur():
    _attaque(20000)
    try:
        code = nouveau_ticket()
        with admin() as c:
            avant = _parcours(c, INDEX_ROUTEUR)
        with en_tant_que_test() as c:
            for _ in range(5):
                d = c.execute("SELECT decision FROM radius._authorize_at(%s, %s, '02-AB-CD-EF-10-01', 'h', now())",
                              (code, R5)).fetchone()[0]
                assert d == "Accept"
        with admin() as c:
            apres = _parcours(c, INDEX_ROUTEUR)
        assert apres == avant, f"authorize a parcouru l'index par routeur ({apres - avant} fois) : coût linéaire sous attaque"
    finally:
        _nettoyer()


def test_post_auth_sous_attaque_compte_au_plus_jusqu_au_seuil_et_alerte_une_fois():
    """Les comptes d'alerte de post_auth s'arrêtent au seuil (LIMIT) ; l'alerte par routeur
    reste levée, une seule fois par fenêtre."""
    _attaque(5000)
    try:
        with admin() as c:
            avant = c.execute("""SELECT count(*) FROM radius.alerte a JOIN app.router r ON r.id = a.router_id
                                  WHERE a.type = 'echecs_routeur' AND r.overlay_ip = %s
                                    AND a.at >= now() - interval '60 seconds'""", (R5,)).fetchone()[0]
        with en_tant_que_radius() as c:
            for _ in range(3):
                assert c.execute("SELECT radius.post_auth(%s, %s, %s, 'Reject', 'ticket_inconnu')",
                                 ("ZZZZ" + uuid.uuid4().hex[:4].upper(), R5,
                                  "02-FB-00-00-00-01")).fetchone()[0] == "ok"
        with admin() as c:
            apres = c.execute("""SELECT count(*) FROM radius.alerte a JOIN app.router r ON r.id = a.router_id
                                  WHERE a.type = 'echecs_routeur' AND r.overlay_ip = %s
                                    AND a.at >= now() - interval '60 seconds'""", (R5,)).fetchone()[0]
        assert apres == max(avant, 1), (avant, apres)
    finally:
        _nettoyer()


def test_l_index_par_routeur_porte_sur_l_expression():
    with admin() as c:
        definition = c.execute("SELECT pg_get_indexdef(%s::regclass)", (f"radius.{INDEX_ROUTEUR}",)).fetchone()[0]
    assert "(router_id + 0)" in definition, definition
