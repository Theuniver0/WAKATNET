"""Unités systemd de la phase 5 (ticket 05 : collecteur de santé) : `systemd-analyze verify`.

L'image de test porte node et l'utilisateur freerad : aucun message n'est toléré. Le rejeu réel
(capacité CAP_NET_ADMIN, lecture du spool par freerad, D-Bus) a lieu sur le nœud.
"""
import subprocess


def test_unites_sante_valides():
    v = subprocess.run(["systemd-analyze", "verify", "--man=no", "/depot/infra/systemd/wakatnet-sante.service",
                        "/depot/infra/systemd/wakatnet-sante.timer"], capture_output=True, text=True)
    assert (v.returncode, v.stdout.strip(), v.stderr.strip()) == (0, "", "")


def test_unites_sauvegarde_et_essai_de_restauration_valides():
    """Ticket 04 (ADR 0015 §5). Seuls messages admis : les scripts, installés sous /opt/wakatnet sur le nœud."""
    unites = [f"/depot/infra/systemd/wakatnet-{n}" for n in
              ("sauvegarde.service", "sauvegarde.timer", "essai-restauration.service", "essai-restauration.timer")]
    v = subprocess.run(["systemd-analyze", "verify", "--man=no", *unites], capture_output=True, text=True)
    autres = [l for l in (v.stdout + v.stderr).splitlines() if l.strip() and not (
        "/opt/wakatnet/infra/noeud/sauvegarder.sh is not executable" in l
        or "/opt/wakatnet/infra/noeud/essai-restauration.sh is not executable" in l)]
    assert autres == [], autres
