"""Codes de ticket (ADR 0006 §15) : alphabet de 31 symboles, 8 caractères, tirage sans biais, unicité."""
import collections
import re

import psycopg
import pytest

from conftest import admin

ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"


def test_alphabet_et_longueur():
    assert len(ALPHABET) == 31
    with admin() as c:
        codes = [r[0] for r in c.execute("SELECT app.generer_code(8) FROM generate_series(1, 3000)").fetchall()]
    assert all(re.fullmatch(r"[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}", x) for x in codes)
    assert len(set(codes)) == len(codes)


def test_distribution_sans_biais_grossier():
    """Khi-deux sur 31 symboles (30 ddl) : seuil 59,7 ≈ risque 0,1 %. Détecte un biais de modulo."""
    with admin() as c:
        texte = "".join(r[0] for r in c.execute("SELECT app.generer_code(8) FROM generate_series(1, 4000)").fetchall())
    compte = collections.Counter(texte)
    attendu = len(texte) / 31
    khi2 = sum((compte[s] - attendu) ** 2 / attendu for s in ALPHABET)
    assert set(compte) <= set(ALPHABET)
    assert khi2 < 59.7, f"khi2 = {khi2:.1f}"


def test_unicite_par_proprietaire():
    with admin() as c:
        code = c.execute("SELECT app.voucher_creer(1, 1)").fetchone()[0]
        with pytest.raises(psycopg.errors.UniqueViolation):
            c.execute("""INSERT INTO app.voucher (tenant_id, plan_id, code, f_prix_xof, f_devices, f_scope)
                         VALUES (1, 1, %s, 100, 1, 'tenant')""", (code,))


def test_meme_code_accepte_chez_un_autre_proprietaire():
    with admin() as c:
        code = c.execute("SELECT app.voucher_creer(1, 1)").fetchone()[0]
        c.execute("""INSERT INTO app.voucher (tenant_id, plan_id, code, f_prix_xof, f_devices, f_scope)
                     VALUES (2, 3, %s, 100, 1, 'tenant')""", (code,))
