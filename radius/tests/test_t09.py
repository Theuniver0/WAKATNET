"""Disconnect et CoA de bout en bout — ticket 09 (T9 partie serveur, T12 coupure au volume ; ADR 0010).

Ticket : .scratch/phase-1-coeur-radius/issues/09-coa-disconnect.md
Le déclencheur de production (infra/coupure/coupure.ts, Node 22, radclient) tourne dans le
conteneur de test et émet depuis l'adresse de nœud du test (conftest.IP_NOEUD_TEST) vers :
  - r13 : faux NAS FreeRADIUS (radius/tests/fauxnas/), qui vérifie l'IP source, le secret et
    le Message-Authenticator, et journalise chaque requête acceptée ;
  - r14 : faux NAS compteur (fauxnas/compteur.py), qui compte chaque paquet reçu et peut
    répondre avec un authentificateur faux.
"""
import hashlib
import hmac
import json
import os
import pathlib
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import uuid

import pytest

from conftest import (IP_NOEUD_TEST, PG_HOTE, ROUTEURS, admin, attendre_rejeu, comptabiliser, creneau_nouveau_client,
                      demander, nouveau_ticket, secret)

COUPURE = "/depot/infra/coupure/coupure.ts"
FAUXNAS = pathlib.Path("/depot/radius/tests/fauxnas")
INTERIM_S = 120   # Acct-Interim-Interval envoyé dans l'Accept (ADR 0006)
R13, R14 = ROUTEURS["r13"][0], ROUTEURS["r14"][0]


def coupure(*args: str, envois: int | str = 3, delai: float | str = 1.0, tmpdir: str | None = None,
            attendre: bool = True, budget: float | str = 20, path: str | None = None):
    """Le déclencheur de production. Son environnement ne contient que ce dont il a besoin."""
    env = {"PATH": path or os.environ["PATH"], "WAKATNET_PG_HOST": PG_HOTE,
           "WAKATNET_PG_COA_PASSWORD": os.environ["WAKATNET_PG_COA_PASSWORD"],
           "WAKATNET_COUPURE_ENVOIS": str(envois), "WAKATNET_COUPURE_DELAI_S": str(delai),
           "WAKATNET_COUPURE_BUDGET_S": str(budget), "NODE_NO_WARNINGS": "1"}
    if tmpdir:
        env["TMPDIR"] = tmpdir
    commande = ["node", COUPURE, *args]
    if not attendre:
        return subprocess.Popen(commande, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return subprocess.run(commande, env=env, capture_output=True, text=True, timeout=180)


@pytest.fixture(scope="module", autouse=True)
def seules_les_sessions_du_test():
    """Le déclencheur traite TOUTES les sessions à couper. Celles des tests précédents visent des
    routeurs sans NAS : elles sont retirées (abandon) pour que chaque tour ne voie que les nôtres."""
    with admin() as c:
        c.execute("""UPDATE radius.session SET coupure_resultat = 'abandon'
                      WHERE coupure_resultat IS NULL AND (a_couper_le IS NOT NULL
                            OR tenant_id IN (SELECT id FROM app.tenant WHERE suspendu))""")
    yield


@pytest.fixture(scope="module")
def fauxnas():
    """FreeRADIUS 3.2.10 en faux NAS sur l'IP de r13, port 1700 (port du routeur en base)."""
    d = pathlib.Path(tempfile.mkdtemp(prefix="fauxnas-"))
    conf = d / "raddb"
    shutil.copytree("/etc/freeradius", conf, symlinks=True)
    for sous in ("sites-enabled", "mods-enabled"):
        shutil.rmtree(conf / sous)
        shutil.copytree(FAUXNAS / sous, conf / sous)
    shutil.copy(FAUXNAS / "clients.conf", conf / "clients.conf")
    os.chmod(d, 0o777)   # radiusd passe sous l'utilisateur freerad pour écrire son journal
    journal = d / "recu.log"
    sortie = open(d / "radiusd.log", "w")
    env = dict(os.environ, FAUXNAS_IP=R13, FAUXNAS_JOURNAL=str(journal))
    p = subprocess.Popen(["freeradius", "-d", str(conf), "-f", "-l", "stdout"], env=env,
                         stdout=sortie, stderr=subprocess.STDOUT)
    fin = time.monotonic() + 15
    while "Ready to process requests" not in (d / "radiusd.log").read_text():
        assert p.poll() is None and time.monotonic() < fin, (d / "radiusd.log").read_text()[-2000:]
        time.sleep(0.1)
    yield journal
    p.terminate()
    p.wait(10)
    sortie.close()


def recus(journal: pathlib.Path) -> list[dict]:
    if not journal.exists():
        return []
    return [dict(kv.split("=", 1) for kv in l.split()) for l in journal.read_text().splitlines() if l.strip()]


def compteur(mode: str, secret_nas: bytes, duree: float):
    """Faux NAS compteur sur r14 ; rend le processus, prêt à recevoir."""
    p = subprocess.Popen(["python3", str(FAUXNAS / "compteur.py"), mode, R14, "1700", str(duree)],
                         env=dict(os.environ, COMPTEUR_SECRET=secret_nas.decode()),
                         stdout=subprocess.PIPE, text=True)
    assert p.stdout.readline().strip() == "pret"
    return p


def bilan(p) -> dict:
    sortie, _ = p.communicate(timeout=60)
    return json.loads(sortie.strip().splitlines()[-1])


def session_ouverte(nom: str, plan_id: int = 1, prefixe: str = "") -> tuple[int, str, str]:
    """Ticket accepté puis Start sur le routeur `nom` ; rend (id de session, Acct-Session-Id, code)."""
    code, sid = nouveau_ticket(plan_id=plan_id), prefixe + uuid.uuid4().hex[:16]
    creneau_nouveau_client()
    r = demander(nom, code=code)
    assert r is not None and r.nom == "Access-Accept", r and r.un("Reply-Message")
    assert comptabiliser(nom, statut="Start", session_id=sid, utilisateur=code).nom == "Accounting-Response"

    def ident():
        with admin() as c:
            l = c.execute("SELECT id FROM radius.session WHERE acct_session_id = %s", (sid,)).fetchone()
        return l and l[0]
    attendre_rejeu(lambda: ident() is not None)
    return ident(), sid, code


def etat(i: int) -> tuple:
    with admin() as c:
        return c.execute("SELECT coupure_resultat, coupure_tentatives FROM radius.session WHERE id = %s", (i,)).fetchone()


def a_couper(i: int) -> None:
    with admin() as c:
        c.execute("UPDATE radius.session SET a_couper_le = now(), motif_coupure = 'volume_epuise' WHERE id = %s", (i,))


def clore(i: int) -> None:
    """Retire une session des tours suivants (elle viserait un NAS que le test a arrêté)."""
    with admin() as c:
        c.execute("UPDATE radius.session SET coupure_resultat = 'abandon' WHERE id = %s AND coupure_resultat IS DISTINCT FROM 'ack'", (i,))


def sans_code_ni_secret(texte: str, code: str) -> None:
    assert code not in texte, "le code du ticket ne doit pas être journalisé par le déclencheur"
    for v in ("WAKATNET_SECRET_R1", "WAKATNET_SECRET_R2", "WAKATNET_PG_COA_PASSWORD"):
        assert os.environ[v] not in texte, f"secret {v} dans la sortie du déclencheur"


# --- T12 de bout en bout ----------------------------------------------------------------

def test_t12_interim_epuise_le_volume_disconnect_recu_avant_un_intervalle(fauxnas):
    i, sid, code = session_ouverte("r13", plan_id=7)   # 1 Go sur 24 heures
    envoi = time.monotonic()
    r = comptabiliser("r13", statut="Interim-Update", session_id=sid, utilisateur=code,
                      octets_entree=600_000_000, octets_sortie=500_000_000, duree=60)
    assert r.nom == "Accounting-Response"
    # Le déclencheur tourne en boucle, comme le timer de production (30 s ; 1 s ici).
    sorties = ""
    while not any(l["sid"] == sid for l in recus(fauxnas)):
        assert time.monotonic() - envoi < INTERIM_S, f"pas de Disconnect en {INTERIM_S} s : {sorties[-500:]}"
        t = coupure()
        sorties += t.stdout + t.stderr
        assert t.returncode == 0, t.stdout + t.stderr
        time.sleep(1)
    delai = time.monotonic() - envoi
    print(f"T12 : Disconnect reçu {delai:.1f} s après l'Interim (intervalle {INTERIM_S} s)")
    ligne, = [l for l in recus(fauxnas) if l["sid"] == sid]
    assert ligne["type"] == "Disconnect-Request"
    assert ligne["src"] == IP_NOEUD_TEST
    assert ligne["user"] == code
    assert ligne["ma"].startswith("0x") and len(ligne["ma"]) == 34, "Message-Authenticator absent"
    assert etat(i) == ("ack", 1)
    with admin() as c:
        assert c.execute("SELECT motif_coupure FROM radius.session WHERE id = %s", (i,)).fetchone()[0] == "volume_epuise"
    assert f"session={i} routeur={R13} motif=volume_epuise envois=1 resultat=ack" in sorties
    sans_code_ni_secret(sorties, code)
    # Acquittée : plus jamais renvoyée.
    n = len(recus(fauxnas))
    assert coupure().returncode == 0
    assert len(recus(fauxnas)) == n


def test_coa_de_debit_recu_par_le_faux_nas(fauxnas):
    i, sid, code = session_ouverte("r13")
    t = coupure("debit", str(i), "1M/2M")
    assert t.returncode == 0, t.stdout + t.stderr
    assert "coa_debit envois=1 resultat=ack" in t.stdout
    ligne, = [l for l in recus(fauxnas) if l["sid"] == sid]
    assert (ligne["type"], ligne["debit"], ligne["user"], ligne["src"]) == ("CoA-Request", "1M/2M", code, IP_NOEUD_TEST)
    sans_code_ni_secret(t.stdout + t.stderr, code)
    assert etat(i) == (None, 0), "un CoA de débit ne compte pas comme une coupure"


@pytest.mark.parametrize("debit", ['1M/2M"\nUser-Name = "X', "1M/2M\\", ""])
def test_coa_de_debit_refuse_une_valeur_qui_injecterait_un_attribut(fauxnas, debit):
    i, _, _ = session_ouverte("r13")
    n = len(recus(fauxnas))
    t = coupure("debit", str(i), debit)
    assert t.returncode == 1 and "débit invalide" in t.stderr, t.stdout + t.stderr   # refusé par la liste blanche
    assert len(recus(fauxnas)) == n


def test_le_port_vient_de_la_base(fauxnas):
    """Tous les routeurs ont 1700 par défaut : un émetteur qui l'ignorerait passerait sinon."""
    i, sid, _ = session_ouverte("r13")
    try:
        with admin() as c:
            c.execute("UPDATE app.router SET coa_port = 3799 WHERE overlay_ip = %s", (R13,))
        t = coupure("debit", str(i), "2M/4M")
        assert t.returncode == 0, t.stdout + t.stderr
    finally:
        with admin() as c:
            c.execute("UPDATE app.router SET coa_port = 1700 WHERE overlay_ip = %s", (R13,))
    ligne, = [l for l in recus(fauxnas) if l["sid"] == sid]
    assert ligne["port"] == "3799"


def test_nak_termine_la_coupure_avec_une_alerte(fauxnas):
    i, _, _ = session_ouverte("r13", prefixe="nak-")
    a_couper(i)
    t = coupure()
    assert t.returncode == 0, t.stdout + t.stderr
    assert etat(i) == ("nak", 1)
    with admin() as c:
        assert c.execute("SELECT count(*) FROM radius.alerte WHERE type = 'coupure_refusee' AND session_id = %s",
                         (i,)).fetchone()[0] == 1


# --- Faux NAS FreeRADIUS : source, secret, Message-Authenticator -------------------------

def _disconnect_brut(source: str, cle: bytes, avec_ma: bool) -> bytes | None:
    """Disconnect-Request construit à la main (RFC 5176 §3, RFC 3579 §3.2), envoyé à r13."""
    ident = os.urandom(1)[0]
    attrs = bytes([1, 2 + 8]) + b"ZZZZZZZZ" + bytes([44, 2 + 8]) + b"sessbrut"
    if avec_ma:
        attrs = bytes([80, 18]) + b"\x00" * 16 + attrs
    longueur = 20 + len(attrs)
    if avec_ma:   # HMAC sur le paquet dont l'authentificateur et le MA sont à zéro
        mac = hmac.new(cle, struct.pack("!BBH", 40, ident, longueur) + b"\x00" * 16 + attrs, hashlib.md5).digest()
        attrs = bytes([80, 18]) + mac + attrs[18:]
    auth = hashlib.md5(struct.pack("!BBH", 40, ident, longueur) + b"\x00" * 16 + attrs + cle).digest()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((source, 0))
    s.settimeout(1.5)
    try:
        s.sendto(struct.pack("!BBH", 40, ident, longueur) + auth + attrs, (R13, 1700))
        return s.recvfrom(4096)[0]
    except socket.timeout:
        return None
    finally:
        s.close()


def test_faux_nas_verifie_source_secret_et_message_authenticator(fauxnas):
    bon = secret("r13")
    assert _disconnect_brut(IP_NOEUD_TEST, bon, True)[0] == 41, "témoin : requête correcte acquittée"
    assert _disconnect_brut(ROUTEURS["r1"][0], bon, True) is None, "IP source hors nœud : ignorée"
    assert _disconnect_brut(IP_NOEUD_TEST, bon, False) is None, "sans Message-Authenticator : ignorée"
    assert _disconnect_brut(IP_NOEUD_TEST, b"pas-le-secret-du-routeur", True) is None, "mauvais secret : ignorée"


# --- Faux NAS compteur : envois exacts, réponse falsifiée, abandon ------------------------

def test_mauvais_secret_aucune_reponse_exactement_n_envois_puis_abandon():
    i, _, code = session_ouverte("r14")
    a_couper(i)
    p = compteur("muet", b"secret-que-le-noeud-ignore", duree=6)
    t = coupure(envois=3, delai=0.5)
    b = bilan(p)
    assert t.returncode == 0, t.stdout + t.stderr
    assert b["recus"] == 3 and b["valides"] == 0, b
    assert set(b["sources"]) == {IP_NOEUD_TEST}
    assert etat(i) == ("sans_reponse", 1)
    assert f"session={i} routeur={R14} motif=volume_epuise envois=3 resultat=sans_reponse" in t.stdout
    sans_code_ni_secret(t.stdout + t.stderr, code)
    # Tours suivants, sans aucun NAS à l'écoute : abandon au 5e tour (coupure_tentatives_max).
    for attendu in ("sans_reponse", "sans_reponse", "sans_reponse", "abandon"):
        assert coupure(envois=1, delai=0.2).returncode == 0
        assert etat(i)[0] == attendu
    assert etat(i) == ("abandon", 5)
    with admin() as c:
        assert c.execute("""SELECT count(*) FROM radius.alerte a JOIN app.router r ON r.id = a.router_id
                             WHERE a.type = 'coupure_abandonnee' AND r.overlay_ip = %s""", (R14,)).fetchone()[0] == 1


def test_reponse_a_l_authentificateur_faux_rejetee_par_l_emetteur():
    i, _, _ = session_ouverte("r14")
    a_couper(i)
    # Le compteur connaît le BON secret : il vérifie au passage que radclient signe juste.
    p = compteur("faux", secret("r14"), duree=6)
    t = coupure(envois=3, delai=0.5)
    b = bilan(p)
    assert b["recus"] == 3 and b["valides"] == 3, b
    assert f"session={i} routeur={R14} reponses_rejetees=3" in t.stdout, t.stdout
    assert etat(i) == ("sans_reponse", 1), "un ACK à l'authentificateur faux n'est pas un ACK"
    clore(i)


def test_secret_jamais_en_ligne_de_commande_ni_laisse_sur_disque():
    i, _, _ = session_ouverte("r14")
    a_couper(i)
    repertoire = tempfile.mkdtemp(prefix="tmp-coupure-")
    p = compteur("muet", b"x" * 16, duree=6)
    t = coupure(envois=2, delai=2.0, tmpdir=repertoire, attendre=False)
    vus, fichiers = [], []
    fin = time.monotonic() + 8
    while t.poll() is None and time.monotonic() < fin:
        for f in pathlib.Path("/proc").glob("[0-9]*/cmdline"):
            try:
                vus.append(f.read_bytes().replace(b"\0", b" "))
            except OSError:
                pass
        for f in pathlib.Path(repertoire).rglob("*"):
            if f.is_file():
                fichiers.append((f.name, oct(f.stat().st_mode & 0o777), oct(f.parent.stat().st_mode & 0o777)))
        time.sleep(0.1)
    t.communicate(timeout=30)
    bilan(p)
    assert any(b"radclient" in v and b"-S" in v for v in vus), "radclient non observé pendant l'envoi"
    assert not any(secret("r14") in v for v in vus), "secret du routeur en ligne de commande"
    assert fichiers and set(fichiers) == {("secret", "0o600", "0o700")}, fichiers
    assert list(pathlib.Path(repertoire).iterdir()) == [], "fichier du secret laissé sur disque"
    clore(i)


def test_une_session_muette_n_affame_pas_les_autres(fauxnas):
    """Revue du ticket 09 : budget du tour, puis les sessions jamais tentées passent en premier."""
    muette, _, _ = session_ouverte("r14")      # aucun NAS n'écoute sur r14
    a_couper(muette)
    vivante, sid, _ = session_ouverte("r13")
    a_couper(vivante)                          # inscrite APRÈS la muette
    t = coupure(envois=3, delai=1.0, budget=1)
    assert "au tour suivant" in t.stdout, t.stdout
    assert etat(muette)[1] == 1 and etat(vivante) == (None, 0), "budget : la vivante attend un tour"
    t = coupure(envois=3, delai=1.0, budget=1)   # la vivante, jamais tentée, passe devant la muette
    assert etat(vivante) == ("ack", 1), t.stdout
    assert any(l["sid"] == sid for l in recus(fauxnas))
    clore(muette)


@pytest.mark.parametrize("cle, valeur", [("envois", "0"), ("envois", "trois"), ("delai", "1s"), ("budget", "0")])
def test_configuration_illisible_aucun_envoi_ni_enregistrement(cle, valeur):
    i, _, _ = session_ouverte("r14")
    a_couper(i)
    t = coupure(**{cle: valeur})
    assert t.returncode == 1 and "configuration :" in t.stderr, t.stdout + t.stderr
    assert etat(i) == (None, 0), "rien ne doit être enregistré"
    clore(i)


def test_panne_de_radclient_visible_et_session_non_marquee(tmp_path):
    """radclient qui échoue sans rien envoyer : une panne de l'émetteur, pas un routeur muet."""
    i, _, _ = session_ouverte("r14")
    a_couper(i)
    faux = tmp_path / "radclient"
    faux.write_text("#!/bin/sh\necho 'dictionnaire illisible' >&2\nexit 1\n")
    faux.chmod(0o755)
    t = coupure(path=f"{tmp_path}:{os.environ['PATH']}")
    assert t.returncode == 1, t.stdout + t.stderr
    assert "radclient (code 1) : dictionnaire illisible" in t.stderr
    assert etat(i) == (None, 0), "aucun abandon ne doit venir d'une panne de l'émetteur"
    clore(i)


def test_retentatives_internes_de_radclient_non_fiables():
    """Fait qui justifie un appel « radclient -r 1 » par envoi (ADR 0010 §2) : avec -r 3,
    radclient 3.2.10 n'envoie que 2 paquets ; avec -r 0, aucun."""
    cle = tempfile.NamedTemporaryFile("w", delete=False)
    cle.write("secret-de-mesure-0123")
    cle.close()
    envois = {}
    for r in (0, 1, 3):
        p = compteur("muet", b"secret-de-mesure-0123", duree=4)
        subprocess.run(["radclient", "-S", cle.name, "-r", str(r), "-t", "0.5", f"{R14}:1700", "disconnect"],
                       input="User-Name = X\nMessage-Authenticator = 0x00\n", capture_output=True, text=True)
        envois[r] = bilan(p)["recus"]
    os.unlink(cle.name)
    assert envois == {0: 0, 1: 1, 3: 2}, envois


def test_unites_systemd_de_la_coupure_valides():
    v = subprocess.run(["systemd-analyze", "verify", "--man=no", "/depot/infra/systemd/wakatnet-coupure.service",
                        "/depot/infra/systemd/wakatnet-coupure.timer"], capture_output=True, text=True)
    # Seul manque toléré : l'exécutable installé sur le nœud (comme aux tickets 06 et 07).
    autres = [l for l in (v.stdout + v.stderr).splitlines()
              if l.strip() and "/opt/wakatnet/coupure/coupure.ts" not in l and "/usr/bin/node" not in l]
    assert autres == [], autres


def test_primaire_en_lecture_seule_aucun_envoi_et_anomalie_signalee(fauxnas):
    """default_transaction_read_only posé sur wk_coa (primaire mis en lecture seule par erreur) :
    aucun Disconnect, rien d'enregistré, et SORTIE 1 pour que systemd le signale (revue).
    La branche « réplique » (pg_is_in_recovery) n'est PAS testée ici : il faut une vraie réplique
    (phase 5, T13)."""
    i, sid, _ = session_ouverte("r13")
    a_couper(i)
    n = len(recus(fauxnas))
    try:
        with admin() as c:
            c.execute("ALTER ROLE wk_coa SET default_transaction_read_only = on")
        t = coupure()
    finally:
        with admin() as c:
            c.execute("ALTER ROLE wk_coa RESET default_transaction_read_only")
    assert t.returncode == 1 and "ANOMALIE : base en lecture seule" in t.stderr, t.stdout + t.stderr
    assert len(recus(fauxnas)) == n and etat(i) == (None, 0)
    clore(i)
