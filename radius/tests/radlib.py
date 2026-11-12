"""WAKATNET — émetteur RADIUS de test (bibliothèque standard seulement).

Pourquoi un émetteur maison, en plus de radclient :
  * radclient ne permet pas de choisir l'IP source, or chaque routeur est
    identifié par son IP dans l'overlay (SPEC §5.1) ;
  * radclient ajoute toujours un Message-Authenticator, or T10 exige un
    paquet SANS (repris de infra/lab/freeradius/tools/radreq.py).

Chaque réponse est vérifiée : Response Authenticator (RFC 2865 §3) et, s'il
est présent, Message-Authenticator (RFC 3579 §3.2). Une réponse invalide lève
une exception : un test ne peut pas « réussir » sur un paquet forgé.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import socket
import struct
from dataclasses import dataclass, field

ACCESS_REQUEST, ACCESS_ACCEPT, ACCESS_REJECT = 1, 2, 3
CODES = {2: "Access-Accept", 3: "Access-Reject", 11: "Access-Challenge"}

# Attributs standard décodés (numéro -> (nom, type)).
STANDARD = {
    1: ("User-Name", "str"),
    18: ("Reply-Message", "str"),
    25: ("Class", "bytes"),
    27: ("Session-Timeout", "int"),
    28: ("Idle-Timeout", "int"),
    62: ("Port-Limit", "int"),
    80: ("Message-Authenticator", "bytes"),
    85: ("Acct-Interim-Interval", "int"),
}
MIKROTIK_VENDOR = 14988
MIKROTIK = {8: ("Mikrotik-Rate-Limit", "str")}


class ReponseInvalide(Exception):
    """Réponse dont l'authentificateur ou le Message-Authenticator est faux."""


@dataclass
class Reponse:
    code: int
    attributs: dict[str, list] = field(default_factory=dict)
    brut: bytes = b""

    @property
    def nom(self) -> str:
        return CODES.get(self.code, str(self.code))

    def un(self, nom: str):
        valeurs = self.attributs.get(nom, [])
        return valeurs[0] if valeurs else None


def _attr(t: int, v: bytes) -> bytes:
    if len(v) > 253:
        raise ValueError("attribut trop long")
    return struct.pack("!BB", t, len(v) + 2) + v


def _pap(mot_de_passe: bytes, secret: bytes, auth: bytes) -> bytes:
    """Chiffrement User-Password (RFC 2865 §5.2)."""
    p = mot_de_passe + b"\x00" * ((16 - len(mot_de_passe) % 16) % 16 or (0 if mot_de_passe else 16))
    sortie, precedent = b"", auth
    for i in range(0, len(p), 16):
        b = hashlib.md5(secret + precedent).digest()
        bloc = bytes(x ^ y for x, y in zip(p[i:i + 16], b))
        sortie += bloc
        precedent = bloc
    return sortie


def _decoder(attrs: bytes) -> dict[str, list]:
    out: dict[str, list] = {}
    i = 0
    while i + 2 <= len(attrs):
        t, longueur = attrs[i], attrs[i + 1]
        if longueur < 2 or i + longueur > len(attrs):
            raise ReponseInvalide("longueur d'attribut invalide")
        v = attrs[i + 2:i + longueur]
        if t == 26 and len(v) >= 6:
            vendeur = struct.unpack("!I", v[:4])[0]
            vt, vl = v[4], v[5]
            vv = v[6:4 + vl]
            if vendeur == MIKROTIK_VENDOR and vt in MIKROTIK:
                nom, typ = MIKROTIK[vt]
            else:
                nom, typ = f"Vendor-{vendeur}-Attr-{vt}", "bytes"
            out.setdefault(nom, []).append(_valeur(vv, typ))
        else:
            nom, typ = STANDARD.get(t, (f"Attr-{t}", "bytes"))
            out.setdefault(nom, []).append(_valeur(v, typ))
        i += longueur
    return out


def _valeur(v: bytes, typ: str):
    if typ == "int":
        if len(v) != 4:
            raise ReponseInvalide("entier de longueur invalide")
        return struct.unpack("!I", v)[0]
    if typ == "str":
        return v.decode(errors="replace")
    return v


def access_request(
    *,
    serveur: str,
    secret: bytes,
    utilisateur: str | bytes,
    mot_de_passe: str,
    methode: str = "chap",
    source: str | None = None,
    port: int = 1812,
    message_authenticator: bool = True,
    calling_station_id: str = "AA-BB-CC-00-00-01",
    called_station_id: str = "hotspot1",
    nas_identifier: str = "routeur-test",
    delai: float = 1.5,
    essais: int = 1,
) -> Reponse | None:
    """Envoie un Access-Request ; renvoie la réponse vérifiée, ou None sans réponse."""
    auth_req = os.urandom(16)
    ident = os.urandom(1)[0]
    # bytes accepté : un User-Name qui n'est pas de l'UTF-8 valide (ticket 08).
    corps = [_attr(1, utilisateur if isinstance(utilisateur, bytes) else utilisateur.encode())]
    if methode == "chap":
        chap_id = os.urandom(1)
        # CHAP-Challenge DISTINCT de l'authentificateur, comme le hotspot MikroTik :
        # un serveur qui utiliserait à tort l'authentificateur échouerait.
        defi = os.urandom(16)
        corps.append(_attr(3, chap_id + hashlib.md5(chap_id + mot_de_passe.encode() + defi).digest()))
        corps.append(_attr(60, defi))
    elif methode == "pap":
        corps.append(_attr(2, _pap(mot_de_passe.encode(), secret, auth_req)))
    else:
        raise ValueError(methode)
    corps += [
        _attr(32, nas_identifier.encode()),
        _attr(31, calling_station_id.encode()),
        _attr(30, called_station_id.encode()),
    ]
    corps_b = b"".join(corps)
    if message_authenticator:
        corps_b = _attr(80, b"\x00" * 16) + corps_b  # en premier (mitigation BlastRADIUS)
    paquet = struct.pack("!BBH", ACCESS_REQUEST, ident, 20 + len(corps_b)) + auth_req + corps_b
    if message_authenticator:
        mac = hmac.new(secret, paquet, hashlib.md5).digest()
        paquet = paquet[:22] + mac + paquet[38:]

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        if source:
            s.bind((source, 0))
        s.settimeout(delai)
        for _ in range(essais):
            s.sendto(paquet, (serveur, port))
            try:
                data, _src = s.recvfrom(4096)
            except socket.timeout:
                continue
            return _verifier(data, auth_req, secret, ident)
        return None
    finally:
        s.close()


ACCOUNTING_REQUEST, ACCOUNTING_RESPONSE = 4, 5
CODES[ACCOUNTING_RESPONSE] = "Accounting-Response"
STATUTS = {"Start": 1, "Stop": 2, "Interim-Update": 3, "Accounting-On": 7, "Accounting-Off": 8}


def accounting_request(
    *,
    serveur: str,
    secret: bytes,
    statut: str,
    session_id: str,
    utilisateur: str | None = None,
    source: str | None = None,
    port: int = 1813,
    octets_entree: int | None = None,
    giga_entree: int | None = None,
    octets_sortie: int | None = None,
    giga_sortie: int | None = None,
    duree: int | None = None,
    cause_fin: int | None = None,
    calling_station_id: str = "AA-BB-CC-00-00-01",
    framed_ip: str | None = "10.5.50.2",
    event_timestamp: int | None = None,
    delai: float = 1.5,
    essais: int = 1,
) -> Reponse | None:
    """Accounting-Request (RFC 2866) ; renvoie l'Accounting-Response vérifiée, ou None.
    Request Authenticator = MD5(code + id + longueur + 16 zéros + attributs + secret)."""
    ident = os.urandom(1)[0]
    entier = lambda t, v: _attr(t, struct.pack("!I", v))
    corps = [entier(40, STATUTS[statut]), _attr(44, session_id.encode())]
    if utilisateur is not None:
        corps.append(_attr(1, utilisateur.encode()))
    for t, v in ((42, octets_entree), (52, giga_entree), (43, octets_sortie), (53, giga_sortie),
                 (46, duree), (49, cause_fin), (55, event_timestamp)):
        if v is not None:
            corps.append(entier(t, v))
    corps += [_attr(31, calling_station_id.encode()), _attr(32, b"routeur-test")]
    if framed_ip:
        corps.append(_attr(8, socket.inet_aton(framed_ip)))
    corps_b = b"".join(corps)
    entete = struct.pack("!BBH", ACCOUNTING_REQUEST, ident, 20 + len(corps_b))
    auth_req = hashlib.md5(entete + b"\x00" * 16 + corps_b + secret).digest()
    paquet = entete + auth_req + corps_b

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        if source:
            s.bind((source, 0))
        s.settimeout(delai)
        for _ in range(essais):
            s.sendto(paquet, (serveur, port))
            try:
                data, _src = s.recvfrom(4096)
            except socket.timeout:
                continue
            return _verifier(data, auth_req, secret, ident)
        return None
    finally:
        s.close()


def _verifier(data: bytes, auth_req: bytes, secret: bytes, ident: int) -> Reponse:
    if len(data) < 20:
        raise ReponseInvalide("réponse trop courte")
    code, rid, longueur = struct.unpack("!BBH", data[:4])
    if not 20 <= longueur <= len(data):
        raise ReponseInvalide("champ Length invalide")
    data = data[:longueur]
    if rid != ident:
        raise ReponseInvalide("identifiant inattendu")
    attendu = hashlib.md5(data[:4] + auth_req + data[20:] + secret).digest()
    if not hmac.compare_digest(attendu, data[4:20]):
        raise ReponseInvalide("Response Authenticator invalide")
    attrs = _decoder(data[20:])
    # Message-Authenticator de la réponse : HMAC calculé avec l'authentificateur
    # de la REQUÊTE à la place de celui de la réponse (RFC 3579 §3.2).
    if "Message-Authenticator" in attrs:
        pos = _position_ma(data)
        copie = bytearray(data)
        copie[4:20] = auth_req
        copie[pos + 2:pos + 18] = b"\x00" * 16
        if not hmac.compare_digest(hmac.new(secret, bytes(copie), hashlib.md5).digest(), data[pos + 2:pos + 18]):
            raise ReponseInvalide("Message-Authenticator de la réponse invalide")
    return Reponse(code=code, attributs=attrs, brut=data)


def _position_ma(data: bytes) -> int:
    i = 20
    while i + 2 <= len(data):
        if data[i] == 80:
            return i
        i += data[i + 1]
    raise ReponseInvalide("Message-Authenticator introuvable")
