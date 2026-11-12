"""Unités systemd de la phase 2 (ticket 05 : wg-agent), vérifiées comme celles de la phase 1.

Ticket : .scratch/phase-2-multi-proprietaires/issues/05-wg-agent.md
Les tests fonctionnels de wg-agent sont dans apps/wg-agent/tests/run.sh (interface WireGuard réelle).
"""
import subprocess


def test_unite_wg_agent_valide():
    v = subprocess.run(["systemd-analyze", "verify", "--man=no", "/depot/infra/systemd/wakatnet-wg-agent.service"],
                       capture_output=True, text=True)
    # Seul manque toléré : le binaire installé sur le nœud.
    autres = [l for l in (v.stdout + v.stderr).splitlines() if l.strip() and "/opt/wakatnet/bin/wg-agent" not in l]
    assert autres == [], autres


def test_unites_taches_phase3_valides():
    """Phase 3, ticket 05 : rapprochement des paiements et frais papier (ADR 0013 §6)."""
    v = subprocess.run(["systemd-analyze", "verify", "--man=no", "/depot/infra/systemd/wakatnet-taches.service",
                        "/depot/infra/systemd/wakatnet-taches.timer"], capture_output=True, text=True)
    autres = [l for l in (v.stdout + v.stderr).splitlines()
              if l.strip() and "/opt/wakatnet/apps/api/src/taches.ts" not in l and "/usr/bin/node" not in l]
    assert autres == [], autres
