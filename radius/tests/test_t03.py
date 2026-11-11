"""T1, T4, T6, scope et suspension, de bout en bout (radclient → FreeRADIUS → radius.authorize).

Ticket : .scratch/phase-1-coeur-radius/issues/03-refus-codes.md
Instant de référence : forme (d) de l'ADR 0007. Les données sont datées dans le passé
par rapport à now(), et la configuration FreeRADIUS de production n'est pas modifiée.
Causes et ordre d'évaluation : ADR 0006 §4.
"""
import re

import pytest

from conftest import admin, creneau_nouveau_client, demander, nouveau_ticket

ATTRS_ACCEPT = ("Session-Timeout", "Mikrotik-Rate-Limit", "Port-Limit", "Acct-Interim-Interval")


def _refus(r, cause):
    assert r is not None, "aucune réponse"
    assert r.nom == "Access-Reject", r.attributs
    assert r.un("Reply-Message") == cause
    for attr in ATTRS_ACCEPT:
        assert r.un(attr) is None, f"{attr} ne doit pas figurer dans un Reject"


@pytest.fixture(scope="module", autouse=True)
def premiers_paquets():
    """r6 et r7 deviennent clients ici. rate_limit = yes : un nouveau client par seconde,
    d'où le créneau libre avant chaque premier paquet (faux positif du 11/11/2026)."""
    for nom in ("r6", "r7"):
        creneau_nouveau_client()
        _refus(demander(nom, code="ZZZZZZZZ", essais=1), "ticket_inconnu")


def _activer(tenant, code, il_y_a):
    with admin() as c:
        c.execute("UPDATE app.voucher SET activated_at = now() - %s::interval WHERE tenant_id = %s AND code = %s",
                  (il_y_a, tenant, code))


# --- T1 -------------------------------------------------------------------

@pytest.mark.parametrize("routeur", ["r1", "r7"])
def test_t1_code_inconnu(routeur):
    _refus(demander(routeur, code="ZZZZZZZZ"), "ticket_inconnu")


# --- T4 -------------------------------------------------------------------

def test_t4_validite_5h_activee_depuis_5h01_refusee():
    code = nouveau_ticket(plan_id=4)
    _activer(1, code, "5 hours 1 minute")
    _refus(demander("r1", code=code), "expire")


def test_t4_controle_positif_activee_depuis_4h59_acceptee_pour_le_reste():
    """Même forfait, une minute avant la fin : Accept, Session-Timeout = fin de validité − maintenant."""
    code = nouveau_ticket(plan_id=4)
    _activer(1, code, "4 hours 59 minutes")
    r = demander("r1", code=code)
    assert r.nom == "Access-Accept", r.attributs
    assert 59 <= r.un("Session-Timeout") <= 60   # tolérance d'une seconde (ADR 0007)


def test_t4_ticket_neuf_a_validite_recoit_la_validite_entiere():
    code = nouveau_ticket(plan_id=4)
    r = demander("r1", code=code)
    assert r.nom == "Access-Accept" and r.un("Session-Timeout") == 18000


def test_t4_expiration_absolue_depassee_meme_jamais_active():
    with admin() as c:
        code = c.execute("SELECT app.voucher_creer(1, 4, now() - interval '1 second')").fetchone()[0]
        assert c.execute("SELECT activated_at FROM app.voucher WHERE tenant_id = 1 AND code = %s",
                         (code,)).fetchone() == (None,)
    _refus(demander("r1", code=code), "expire")


# --- T6 -------------------------------------------------------------------

def test_t6_ticket_de_a_presente_sur_un_routeur_de_b():
    code = nouveau_ticket(plan_id=1, tenant_id=1)
    _refus(demander("r7", code=code), "ticket_inconnu")
    assert demander("r1", code=code).nom == "Access-Accept"   # contrôle positif chez A


def test_t6_meme_code_chez_a_et_b_chacun_recoit_son_ticket():
    """La clé est (propriétaire, code) : le même code désigne deux tickets distincts."""
    code = nouveau_ticket(plan_id=1, tenant_id=1)
    with admin() as c:
        c.execute("""INSERT INTO app.voucher (tenant_id, plan_id, code, f_prix_xof, f_uptime_limit_s,
                                              f_rate_limit, f_devices, f_scope)
                     VALUES (2, 3, %s, 100, 1800, '1M/1M', 1, 'tenant')""", (code,))
    a, b = demander("r1", code=code), demander("r7", code=code)
    assert (a.nom, a.un("Session-Timeout"), a.un("Mikrotik-Rate-Limit")) == ("Access-Accept", 3600, "512k/2M")
    assert (b.nom, b.un("Session-Timeout"), b.un("Mikrotik-Rate-Limit")) == ("Access-Accept", 1800, "1M/1M")


# --- scope ----------------------------------------------------------------

def test_scope_site_refuse_sur_un_autre_site_du_meme_proprietaire():
    code = nouveau_ticket(plan_id=5)                     # limité au site S2
    _refus(demander("r1", code=code), "mauvais_site")    # r1 : site S1
    r = demander("r6", code=code)                        # r6 : site S2
    assert r.nom == "Access-Accept" and r.un("Session-Timeout") == 3600


def test_scope_proprietaire_accepte_sur_les_deux_sites():
    code = nouveau_ticket(plan_id=1)
    assert demander("r1", code=code).nom == "Access-Accept"
    assert demander("r6", code=code).nom == "Access-Accept"


def test_scope_fige_sur_le_ticket():
    """Copie figée (§5.3) : élargir le forfait après la vente ne change pas le ticket."""
    code = nouveau_ticket(plan_id=5)
    with admin() as c:
        c.execute("UPDATE app.plan SET scope = 'tenant', site_id = NULL WHERE id = 5")
    try:
        _refus(demander("r1", code=code), "mauvais_site")
    finally:
        with admin() as c:
            c.execute("UPDATE app.plan SET scope = 'site', site_id = 2 WHERE id = 5")


# --- suspension -----------------------------------------------------------

def test_proprietaire_suspendu_puis_retabli():
    code = nouveau_ticket(plan_id=3, tenant_id=2)
    with admin() as c:
        c.execute("UPDATE app.tenant SET suspendu = true WHERE id = 2")
    try:
        _refus(demander("r7", code=code), "proprietaire_suspendu")
        # Ordre de l'ADR 0006 §4 : ticket_inconnu passe avant proprietaire_suspendu.
        _refus(demander("r7", code="ZZZZZZZZ"), "ticket_inconnu")
    finally:
        with admin() as c:
            c.execute("UPDATE app.tenant SET suspendu = false WHERE id = 2")
    assert demander("r7", code=code).nom == "Access-Accept"


def test_suspension_de_b_sans_effet_sur_a():
    code = nouveau_ticket(plan_id=1, tenant_id=1)
    with admin() as c:
        c.execute("UPDATE app.tenant SET suspendu = true WHERE id = 2")
    try:
        assert demander("r1", code=code).nom == "Access-Accept"
    finally:
        with admin() as c:
            c.execute("UPDATE app.tenant SET suspendu = false WHERE id = 2")


# --- découvert ------------------------------------------------------------

def test_garde_decision_d_acces_sans_lecture_des_credits():
    """GARDE PARTIELLE, pas une preuve, du critère « propriétaire au plafond de découvert →
    ticket accepté » (ADR 0001, ADR 0006 §4). Les crédits n'existent qu'en phase 3 ; le test
    de bout en bout avec un propriétaire au plafond y est dû (docs/PLAN.md, ticket 3.4).

    Ce que le test vérifie, sur le texte des fonctions (commentaires retirés) :
      * relations qualifiées : seulement app.router, app.tenant, app.voucher, radius.parametre,
        radius.session (consommation, ticket 05) ;
      * appels de fonction : seulement une liste fermée de fonctions intégrées ; un appel non
        qualifié (résolu par search_path) ou une nouvelle fonction le fait échouer ;
      * app.tenant : seules les colonnes id et suspendu sont lues ; ni SELECT * ni %ROWTYPE.
    Limite connue : une lecture transitive (vue sur app.tenant jointe au grand livre) passerait.
    Toute modification de ces fonctions doit donc revoir cette liste, et non l'élargir par défaut.
    """
    # radius.session (ticket 05) : consommation du ticket (temps, volume), aucune colonne de crédit.
    relations = {"app.router", "app.tenant", "app.voucher", "radius.parametre", "radius.session", "radius._authorize_at"}
    appels = {"coalesce", "extract", "floor", "isfinite", "least", "upper", "now", "sum", "radius._authorize_at",
              "or", "and", "not", "in"}   # mots-clés suivis d'une parenthèse
    with admin() as c:
        sources = c.execute("""SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                WHERE n.nspname = 'radius' AND p.proname IN ('authorize', '_authorize_at')""").fetchall()
    assert len(sources) == 2
    for nom, source in sources:
        code = re.sub(r"--[^\n]*", "", source)
        lues = {m.lower() for m in re.findall(r"\b(?:app|radius|ledger|public)\.[a-z_][a-z0-9_]*", code, re.I)}
        assert lues <= relations, f"{nom} lit {sorted(lues - relations)}"
        appelees = {m.lower() for m in re.findall(r"([A-Za-z_][A-Za-z0-9_.]*)\s*\(", code)}
        assert appelees <= appels, f"{nom} appelle {sorted(appelees - appels)}"
        assert not re.search(r"app\.tenant%ROWTYPE|\*\s+INTO\s+\w+\s+FROM\s+app\.tenant", code, re.I)
        for alias in re.findall(r"app\.tenant\s+(?:AS\s+)?([a-z_]\w*)", code, re.I):
            colonnes = {m.lower() for m in re.findall(rf"\b{alias}\.(\w+)", code)}
            assert colonnes <= {"id", "suspendu"}, f"{nom} lit app.tenant.{sorted(colonnes - {'id', 'suspendu'})}"
