"""WAKATNET — fixtures communes de la matrice T (ADR 0007 et 0008).

Topologie de test (compose.yml) :
  serveur FreeRADIUS : 10.213.0.1 (overlay) · 172.29.214.2 (hors overlay)
  routeurs simulés   : IP portées par le conteneur testeur (une par routeur)

Données déterministes, créées par le superutilisateur de test. Les objets
propres aux tests (rôle wk_test, droits sur la fonction interne) ne sont créés
qu'ici, jamais par les migrations de production (ADR 0007).
"""
from __future__ import annotations

import os
import subprocess
import time

import psycopg
import pytest

import radlib

SERVEUR = "10.213.0.1"
SERVEUR_HORS = "172.29.214.2"
PG_HOTE = "172.29.215.5"

# Routeurs simulés : nom -> (IP source, actif, variable du secret)
ROUTEURS = {
    "r1": ("10.213.1.10", True, "WAKATNET_SECRET_R1"),   # IP principale du testeur
    "r2": ("10.213.1.20", True, "WAKATNET_SECRET_R2"),
    "r3": ("10.213.1.30", False, "WAKATNET_SECRET_R3"),  # routeur désactivé
    "r4": ("10.213.1.40", True, "WAKATNET_SECRET_R2"),   # réservé au premier paquet sans Message-Authenticator (T10)
    "r5": ("10.213.1.50", True, "WAKATNET_SECRET_R3"),   # réservé à la désactivation en base (L4)
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


def _ip_secondaires() -> None:
    sortie = subprocess.run(["ip", "-o", "-4", "addr"], capture_output=True, text=True, check=True).stdout
    iface = next(l.split()[1] for l in sortie.splitlines() if "10.213.1.10/" in l)
    for ip in [r[0] for r in ROUTEURS.values()] + [IP_INCONNUE]:
        if f" {ip}/" not in sortie:
            subprocess.run(["ip", "addr", "add", f"{ip}/16", "dev", iface], check=True)


@pytest.fixture(scope="session", autouse=True)
def donnees():
    """Jeu de données déterministe de la phase 1, ticket 02."""
    _ip_secondaires()
    with admin() as c:
        c.execute("""
            TRUNCATE app.voucher, app.plan, app.router, app.site, app.tenant RESTART IDENTITY CASCADE;
            INSERT INTO app.tenant (id, nom) OVERRIDING SYSTEM VALUE VALUES (1, 'Proprietaire A'), (2, 'Proprietaire B');
            INSERT INTO app.site (id, tenant_id, nom) OVERRIDING SYSTEM VALUE
              VALUES (1, 1, 'Site S1'), (2, 1, 'Site S2'), (3, 2, 'Site B1');
        """)
        for i, (nom, (ip, actif, var)) in enumerate(ROUTEURS.items(), start=1):
            c.execute(
                "INSERT INTO app.router (id, tenant_id, site_id, overlay_ip, shortname, actif)"
                " OVERRIDING SYSTEM VALUE VALUES (%s, 1, 1, %s, %s, %s)", (i, ip, nom, actif))
            c.execute("INSERT INTO radius.router_secret (router_id, secret) VALUES (%s, %s)",
                      (i, os.environ[var]))
        c.execute("""
            INSERT INTO app.plan (id, tenant_id, nom, prix_xof, uptime_limit_s, rate_limit, devices)
            OVERRIDING SYSTEM VALUE VALUES (1, 1, '1 heure', 100, 3600, '512k/2M', 1),
                                           (2, 1, '1 heure sans débit', 100, 3600, NULL, 1),
                                           (3, 2, '1 heure (B)', 100, 3600, '1M/1M', 1);
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


def nouveau_ticket(plan_id: int = 1, tenant_id: int = 1) -> str:
    with admin() as c:
        return c.execute("SELECT app.voucher_creer(%s, %s)", (tenant_id, plan_id)).fetchone()[0]


def demander(nom: str = "r1", *, code: str, mot_de_passe: str | None = None, **kw):
    """Access-Request depuis l'IP du routeur `nom`. TOUTE réponse doit porter un
    Message-Authenticator (RouterOS >= 7.15 refuse sinon le login, SPEC §1.1)."""
    ip = ROUTEURS[nom][0]
    kw.setdefault("essais", 3)
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
