"""Écart test / production (ADR 0008 §5) : la liste des surcharges est fermée."""
import pathlib
import re

ICI = pathlib.Path(__file__).parent
FREERADIUS = pathlib.Path("/depot/infra/freeradius")


def _cles_env():
    return {l.split("=", 1)[0] for l in (ICI / "surcharges/test.env").read_text().splitlines()
            if l.strip() and not l.startswith("#")}


def _cles_liste():
    return set(re.findall(r"^\| `(WAKATNET_[A-Z_]+)` \|", (ICI / "surcharges/LISTE.md").read_text(), re.M))


def test_surcharges_listees_exactement():
    assert _cles_env() == _cles_liste()


def test_chaque_surcharge_est_lue_par_la_configuration_de_production():
    texte = "\n".join(p.read_text() for p in FREERADIUS.rglob("*") if p.is_file())
    for cle in _cles_env():
        assert f"$ENV{{{cle}}}" in texte, f"{cle} n'est lue par aucun fichier de infra/freeradius"


def test_aucune_valeur_de_test_en_dur_dans_la_production():
    texte = "\n".join(p.read_text() for p in FREERADIUS.rglob("*") if p.is_file())
    texte = "\n".join(p.read_text() for p in FREERADIUS.rglob("*") if p.is_file() and p.name != "production.env")
    for valeur in ("172.29.215.5", "172.29.214", "lifetime = 20"):
        assert valeur not in texte


def test_fichier_de_production_versionne_memes_cles_et_lifetime_300():
    prod = {}
    for l in (FREERADIUS / "production.env").read_text().splitlines():
        if l.strip() and not l.startswith("#"):
            k, v = l.split("=", 1)
            prod[k] = v
    assert set(prod) == _cles_env()
    assert prod["WAKATNET_CLIENT_LIFETIME"] == "300"
    assert prod["WAKATNET_RADIUS_LISTEN"] == "10.213.0.1"
