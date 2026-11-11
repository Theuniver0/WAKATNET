"""Test de fumée exécuté juste après les migrations (ADR 0006 §13, ADR 0008 §1).

En tant que wk_radius, client_lookup et authorize doivent répondre sans erreur.
Une migration qui casserait un droit ou une fonction rendrait le nœud muet :
ce test l'arrête avant.
"""
from conftest import en_tant_que_radius


def test_client_lookup_et_authorize_repondent_en_tant_que_wk_radius():
    with en_tant_que_radius() as c:
        c.execute("SELECT * FROM radius.client_lookup('10.213.1.10')").fetchall()
        c.execute("SELECT * FROM radius.client_lookup('pas-une-ip')").fetchall()
        c.execute("SELECT * FROM radius.authorize('ABCDEFGH', '10.213.1.10', 'AA-BB', 'hs')").fetchall()
        c.execute("SELECT * FROM radius.authorize('', '', '', '')").fetchall()
