"""WAKATNET — fixtures communes de la matrice T (ADR 0007 et 0008).

Topologie de test (compose.yml) :
  serveur FreeRADIUS : 10.213.0.1 (overlay) · 172.29.214.2 (hors overlay)
  routeurs simulés   : IP portées par le conteneur testeur (une par routeur)

Données déterministes, créées par le superutilisateur de test. Les objets
propres aux tests (rôle wk_test, droits sur la fonction interne) ne sont créés
qu'ici, jamais par les migrations de production (ADR 0007).
"""
from __future__ import annotations

import glob
import os
import subprocess
import time

import psycopg
import pytest

import radlib

SERVEUR = "10.213.0.1"
# Spool de l'accounting (volume partagé, lecture seule ici) : fichiers detail en attente
# de rejeu. « detail vidé » = aucun fichier detail-* ni detail.work (ADR 0008 §3).
SPOOL = "/radacct/wakatnet"
SERVEUR_HORS = "172.29.214.2"
PG_HOTE = "172.29.215.5"

# Routeurs simulés : nom -> (IP source, actif, variable du secret, propriétaire, site)
ROUTEURS = {
    "r1": ("10.213.1.10", True, "WAKATNET_SECRET_R1", 1, 1),   # IP principale du testeur
    "r2": ("10.213.1.20", True, "WAKATNET_SECRET_R2", 1, 1),
    "r3": ("10.213.1.30", False, "WAKATNET_SECRET_R3", 1, 1),  # routeur désactivé
    "r4": ("10.213.1.40", True, "WAKATNET_SECRET_R2", 1, 1),   # réservé au premier paquet sans Message-Authenticator (T10)
    "r5": ("10.213.1.50", True, "WAKATNET_SECRET_R3", 1, 1),   # réservé à la désactivation en base (L4)
    "r6": ("10.213.1.60", True, "WAKATNET_SECRET_R1", 1, 2),   # propriétaire A, site S2 (scope, ticket 03)
    "r7": ("10.213.1.70", True, "WAKATNET_SECRET_R2", 2, 3),   # propriétaire B (T6, suspension, ticket 03)
    # Réservés aux étapes « base indisponible » du ticket 04 : leur client dynamique est créé
    # juste avant l'arrêt (r8) ou le gel (r9) de la base, donc encore en cache pendant l'étape.
    "r8": ("10.213.1.80", True, "WAKATNET_SECRET_R1", 1, 1),
    "r9": ("10.213.1.90", True, "WAKATNET_SECRET_R2", 1, 1),
}

# Routeurs présents en base seulement (aucun paquet RADIUS) : tests SQL de la forme (a)
# de l'ADR 0007, sur le propriétaire C, que ces tests suspendent et rétablissent.
ROUTEURS_SQL = {
    "c4": ("10.213.2.4", 3, 4),
    "c5": ("10.213.2.5", 3, 5),
}
IP_INCONNUE = "10.213.9.99"   # dans l'overlay, aucun routeur
IP_HORS = "172.29.214.10"     # hors overlay


def secret(nom: str) -> bytes:
    return os.environ[ROUTEURS[nom][2]].encode()


def admin() -> psycopg.Connection:
    return psycopg.connect(host=PG_HOTE, dbname="wakatnet", user="wakatnet_admin",
                           password=os.environ["POSTGRES_PASSWORD"], autocommit=True)


def en_tant_que_radius() -> psycopg.Connection:
    return psycopg.connect(host=PG_HOTE, dbname="wakatnet", user="wk_radius",
                           password=os.environ["WAKATNET_PG_RADIUS_PASSWORD"], autocommit=True)


def en_tant_que_acct() -> psycopg.Connection:
    """Rôle wk_acct : celui du lecteur detail (ADR 0006 §12)."""
    return psycopg.connect(host=PG_HOTE, dbname="wakatnet", user="wk_acct",
                           password=os.environ["WAKATNET_PG_ACCT_PASSWORD"], autocommit=True)


def en_tant_que_maint() -> psycopg.Connection:
    """Rôle wk_maint : tâches planifiées (sessions fantômes, purge) — ADR 0006 §1, §17."""
    return psycopg.connect(host=PG_HOTE, dbname="wakatnet", user="wk_maint",
                           password=os.environ["WAKATNET_PG_MAINT_PASSWORD"], autocommit=True)


def en_tant_que_test() -> psycopg.Connection:
    """Rôle wk_test (ADR 0007) : seul autorisé sur radius._authorize_at (instant injecté)."""
    return psycopg.connect(host=PG_HOTE, dbname="wakatnet", user="wk_test",
                           password=os.environ["WAKATNET_PG_TEST_PASSWORD"], autocommit=True)


def _ip_secondaires() -> None:
    sortie = subprocess.run(["ip", "-o", "-4", "addr"], capture_output=True, text=True, check=True).stdout
    iface = next(l.split()[1] for l in sortie.splitlines() if "10.213.1.10/" in l)
    for ip in [r[0] for r in ROUTEURS.values()] + [IP_INCONNUE]:
        if f" {ip}/" not in sortie:
            subprocess.run(["ip", "addr", "add", f"{ip}/16", "dev", iface], check=True)


@pytest.fixture(scope="session", autouse=True)
def donnees():
    """Jeu de données déterministe de la phase 1.

    WAKATNET_SANS_FIXTURES=1 : étapes « base indisponible » orchestrées par run.sh
    (ADR 0008, amendement du ticket 04). La base peut être arrêtée : on garde les
    données du passage principal et on ne touche pas à PostgreSQL."""
    _ip_secondaires()
    if os.environ.get("WAKATNET_SANS_FIXTURES") == "1":
        yield
        return
    with admin() as c:
        c.execute("""
            TRUNCATE app.voucher, app.plan, app.router, app.site, app.tenant RESTART IDENTITY CASCADE;
            INSERT INTO app.tenant (id, nom) OVERRIDING SYSTEM VALUE
              VALUES (1, 'Proprietaire A'), (2, 'Proprietaire B'), (3, 'Proprietaire C (SQL)');
            INSERT INTO app.site (id, tenant_id, nom) OVERRIDING SYSTEM VALUE
              VALUES (1, 1, 'Site S1'), (2, 1, 'Site S2'), (3, 2, 'Site B1'), (4, 3, 'Site C1'), (5, 3, 'Site C2');
        """)
        for i, (nom, (ip, actif, var, tenant, site)) in enumerate(ROUTEURS.items(), start=1):
            c.execute(
                "INSERT INTO app.router (id, tenant_id, site_id, overlay_ip, shortname, actif)"
                " OVERRIDING SYSTEM VALUE VALUES (%s, %s, %s, %s, %s, %s)", (i, tenant, site, ip, nom, actif))
            c.execute("INSERT INTO radius.router_secret (router_id, secret) VALUES (%s, %s)",
                      (i, os.environ[var]))
        for i, (nom, (ip, tenant, site)) in enumerate(ROUTEURS_SQL.items(), start=len(ROUTEURS) + 1):
            c.execute(
                "INSERT INTO app.router (id, tenant_id, site_id, overlay_ip, shortname)"
                " OVERRIDING SYSTEM VALUE VALUES (%s, %s, %s, %s, %s)", (i, tenant, site, ip, nom))
        c.execute("""
            INSERT INTO app.plan (id, tenant_id, nom, prix_xof, uptime_limit_s, validity_s, data_limit_bytes,
                                  rate_limit, devices, scope, site_id)
            OVERRIDING SYSTEM VALUE VALUES
              (1, 1, '1 heure', 100, 3600, NULL, NULL, '512k/2M', 1, 'tenant', NULL),
              (2, 1, '1 heure sans débit', 100, 3600, NULL, NULL, NULL, 1, 'tenant', NULL),
              (3, 2, '1 heure (B)', 100, 3600, NULL, NULL, '1M/1M', 1, 'tenant', NULL),
              (4, 1, 'Validité 5 heures', 200, NULL, 18000, NULL, NULL, 1, 'tenant', NULL),
              (5, 1, '1 heure, site S2 seulement', 100, 3600, NULL, NULL, NULL, 1, 'site', 2),
              (6, 3, '1 heure (C, tests SQL)', 100, 3600, NULL, NULL, '2M/2M', 2, 'tenant', NULL),
              (7, 1, '1 Go sur 24 heures', 500, 86400, NULL, 1000000000, NULL, 1, 'tenant', NULL),
              (8, 1, '1 heure, 2 appareils', 150, 3600, NULL, NULL, NULL, 2, 'tenant', NULL);
            INSERT INTO app.plan (id, tenant_id, nom, prix_xof, uptime_limit_s, devices, bind_mac)
            OVERRIDING SYSTEM VALUE VALUES (9, 1, '1 heure, lié au premier appareil', 100, 3600, 1, true);
        """)
        # Rôle de test (ADR 0007) : seul autorisé sur la fonction interne à instant injecté.
        c.execute("""
            DO $$ BEGIN
              IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wk_test') THEN
                CREATE ROLE wk_test LOGIN;
              END IF;
            END $$;
        """)
        c.execute("SELECT set_config('wakatnet.mdp_test', %s, false)", (os.environ["WAKATNET_PG_TEST_PASSWORD"],))
        c.execute("DO $$ BEGIN EXECUTE format('ALTER ROLE wk_test PASSWORD %L', current_setting('wakatnet.mdp_test')); END $$;")
        c.execute("GRANT USAGE ON SCHEMA radius TO wk_test")
        c.execute("GRANT EXECUTE ON FUNCTION radius._authorize_at(text, text, text, text, timestamptz) TO wk_test")
    yield


# MAC de l'appareil simulé, PROPRE À CHAQUE TEST (ticket 07) : l'anti-devinette bloque une MAC
# après 10 échecs en 60 s sur un routeur ; sans cela, les refus volontaires de tests différents
# s'additionneraient. Dans un même test, la MAC reste la même (compte d'appareils, ticket 06).
MAC_COURANTE = "02-00-00-00-00-01"


@pytest.fixture(autouse=True)
def mac_du_test():
    global MAC_COURANTE
    MAC_COURANTE = "02-" + "-".join(os.urandom(5).hex()[i:i + 2] for i in range(0, 10, 2)).upper()
    yield


def nouveau_ticket(plan_id: int = 1, tenant_id: int = 1) -> str:
    with admin() as c:
        return c.execute("SELECT app.voucher_creer(%s, %s)", (tenant_id, plan_id)).fetchone()[0]


def demander(nom: str = "r1", *, code: str, mot_de_passe: str | None = None, **kw):
    """Access-Request depuis l'IP du routeur `nom`. TOUTE réponse doit porter un
    Message-Authenticator (RouterOS >= 7.15 refuse sinon le login, SPEC §1.1)."""
    ip = ROUTEURS[nom][0]
    kw.setdefault("essais", 3)
    kw.setdefault("calling_station_id", MAC_COURANTE)
    r = radlib.access_request(serveur=SERVEUR, secret=secret(nom), source=ip,
                              utilisateur=code, mot_de_passe=mot_de_passe if mot_de_passe is not None else code,
                              **kw)
    if r is not None:
        assert r.un("Message-Authenticator") is not None, f"{r.nom} sans Message-Authenticator"
    return r


def creneau_nouveau_client() -> None:
    """rate_limit = yes : un seul NOUVEAU client par seconde pour tout l'overlay.
    Avant le premier paquet d'une IP, on attend que le créneau soit libre, pour
    qu'une absence de réponse ne puisse pas venir du débit (faux positif du 11/11/2026)."""
    time.sleep(1.5)


def comptabiliser(nom: str = "r1", **kw):
    """Accounting-Request depuis l'IP du routeur `nom` ; renvoie l'Accounting-Response vérifiée."""
    kw.setdefault("essais", 3)
    kw.setdefault("calling_station_id", MAC_COURANTE)
    return radlib.accounting_request(serveur=SERVEUR, secret=secret(nom), source=ROUTEURS[nom][0], **kw)


def spool_vide() -> bool:
    return not (glob.glob(os.path.join(SPOOL, "detail-*")) or glob.glob(os.path.join(SPOOL, "detail.work")))


def attendre_rejeu(condition=lambda: True, delai: float = 45.0, message: str = ""):
    """Primitive « detail vidé » (ADR 0008 §3) : attend que le spool soit vide ET que la
    condition (lecture en base) soit vraie. Délai maximal explicite, jamais de sleep fixe."""
    fin = time.monotonic() + delai
    while time.monotonic() < fin:
        if spool_vide():
            try:
                if condition():
                    return
            except psycopg.OperationalError:
                pass
        time.sleep(0.25)
    raise AssertionError(f"rejeu non terminé après {delai} s (spool vide : {spool_vide()}) {message}")
