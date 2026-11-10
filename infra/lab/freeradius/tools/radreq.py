#!/usr/bin/env python3
"""WAKATNET labo — émetteur Access-Request CHAP minimal (bibliothèque standard seulement).

Pourquoi : radclient 3.2.5 ajoute TOUJOURS un Message-Authenticator aux
Access-Request (observé dans radiusd -X), même si le fichier de paquet n'en
contient pas. Pour tester T10 (paquet SANS Message-Authenticator), il faut un
émetteur qui maîtrise le contenu exact du paquet. Ce script :
  * construit un Access-Request CHAP (RFC 2865 / 1994), avec ou sans
    Message-Authenticator (RFC 3579 §3.2, HMAC-MD5) ;
  * vérifie le Response Authenticator de la réponse ;
  * affiche le résultat avec les mêmes mots que radclient
    ("Received Access-Accept", "No reply from server").
Lit le secret dans un fichier (jamais sur la ligne de commande).
"""
import argparse, hashlib, hmac, os, socket, struct, sys

CODES = {2: "Access-Accept", 3: "Access-Reject", 11: "Access-Challenge"}


def attr(t, v):
    return struct.pack("!BB", t, len(v) + 2) + v


def decode(attrs):
    out, i = [], 0
    while i + 2 <= len(attrs):
        t, l = attrs[i], attrs[i + 1]
        v = attrs[i + 2:i + l]
        if t == 18:
            out.append('Reply-Message = "%s"' % v.decode(errors="replace"))
        elif t == 27:
            out.append("Session-Timeout = %d" % struct.unpack("!I", v)[0])
        elif t == 80:
            out.append("Message-Authenticator = 0x" + v.hex())
        elif t == 26 and len(v) >= 6:
            vendor = struct.unpack("!I", v[:4])[0]
            vt, vl = v[4], v[5]
            vv = v[6:4 + vl]
            if vendor == 14988 and vt == 8:
                out.append('Mikrotik-Rate-Limit = "%s"' % vv.decode(errors="replace"))
            else:
                out.append("Vendor-%d-Attr-%d = 0x%s" % (vendor, vt, vv.hex()))
        else:
            out.append("Attr-%d = 0x%s" % (t, v.hex()))
        i += max(l, 2)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True)
    ap.add_argument("--port", type=int, default=1812)
    ap.add_argument("--secret-file", required=True)
    ap.add_argument("--user", required=True)
    ap.add_argument("--chap-password", required=True)
    ap.add_argument("--nas-identifier", default="labo")
    ap.add_argument("--calling-station-id", default="AA-BB-CC-00-00-01")
    ap.add_argument("--called-station-id", default="hotspot1")
    ap.add_argument("--no-ma", action="store_true", help="ne PAS mettre de Message-Authenticator")
    ap.add_argument("--timeout", type=float, default=2.0)
    ap.add_argument("--retries", type=int, default=2)
    a = ap.parse_args()

    secret = open(a.secret_file, "rb").read().strip()
    pid = os.urandom(1)[0]
    req_auth = os.urandom(16)
    chap_id = os.urandom(1)
    chap = chap_id + hashlib.md5(chap_id + a.chap_password.encode() + req_auth).digest()

    body = b"".join([
        attr(1, a.user.encode()),
        attr(3, chap),
        attr(32, a.nas_identifier.encode()),
        attr(31, a.calling_station_id.encode()),
        attr(30, a.called_station_id.encode()),
    ])
    if not a.no_ma:
        body = attr(80, b"\x00" * 16) + body  # en premier, comme le recommande la mitigation BlastRADIUS
    length = 20 + len(body)
    pkt = struct.pack("!BBH", 1, pid, length) + req_auth + body
    if not a.no_ma:
        mac = hmac.new(secret, pkt, hashlib.md5).digest()
        pkt = pkt[:22] + mac + pkt[38:]

    print("Sent Access-Request Id %d to %s:%d length %d Message-Authenticator=%s"
          % (pid, a.server, a.port, length, "absent" if a.no_ma else "présent"))
    print("  packet hex: " + pkt.hex())
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(a.timeout)
    for attempt in range(a.retries + 1):
        s.sendto(pkt, (a.server, a.port))
        try:
            data, src = s.recvfrom(4096)
        except socket.timeout:
            print("  (essai %d) pas de réponse après %.1f s" % (attempt + 1, a.timeout))
            continue
        code, rid, rlen = struct.unpack("!BBH", data[:4])
        expect = hashlib.md5(data[:4] + req_auth + data[20:rlen] + secret).digest()
        if expect != data[4:20]:
            print("Received packet from %s with invalid Response Authenticator" % src[0])
            return 3
        print("Received %s Id %d from %s:%d length %d" % (CODES.get(code, str(code)), rid, src[0], src[1], rlen))
        for line in decode(data[20:rlen]):
            print("\t" + line)
        return 0
    print("No reply from server for ID %d" % pid)
    return 1


if __name__ == "__main__":
    sys.exit(main())
