package main

import (
	"net"
	"net/netip"
	"testing"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func cle(t *testing.T) wgtypes.Key {
	t.Helper()
	k, err := wgtypes.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	return k.PublicKey()
}

func pair(t *testing.T, ip string) Pair { return Pair{Cle: cle(t), IP: netip.MustParseAddr(ip)} }

func actuel(p Pair, ips ...string) wgtypes.Peer {
	var a []net.IPNet
	for _, s := range ips {
		_, n, _ := net.ParseCIDR(s)
		a = append(a, *n)
	}
	return wgtypes.Peer{PublicKey: p.Cle, AllowedIPs: a}
}

func TestAjoutRetraitEtCorrection(t *testing.T) {
	garde, neuf, faux, etranger := pair(t, "10.213.1.1"), pair(t, "10.213.1.2"), pair(t, "10.213.1.3"), pair(t, "10.213.9.9")
	p := Planifier([]Pair{garde, neuf, faux},
		[]wgtypes.Peer{actuel(garde, "10.213.1.1/32"), actuel(faux, "10.213.1.3/32", "0.0.0.0/0"), actuel(etranger, "10.213.9.9/32")}, false)
	if len(p.Ajouts) != 1 || p.Ajouts[0].Cle != neuf.Cle {
		t.Fatalf("ajouts : %+v", p.Ajouts)
	}
	if len(p.MisesAJour) != 1 || p.MisesAJour[0].Cle != faux.Cle {
		t.Fatalf("corrections : %+v", p.MisesAJour)
	}
	if len(p.Retraits) != 1 || p.Retraits[0] != etranger.Cle || p.Anomalie != "" {
		t.Fatalf("retraits : %+v %q", p.Retraits, p.Anomalie)
	}
	for _, c := range p.Config.Peers {
		if c.Remove {
			continue
		}
		if !c.ReplaceAllowedIPs || len(c.AllowedIPs) != 1 || c.AllowedIPs[0].String() != map[wgtypes.Key]string{neuf.Cle: "10.213.1.2/32", faux.Cle: "10.213.1.3/32"}[c.PublicKey] {
			t.Fatalf("AllowedIPs doit valoir exactement le /32 : %+v", c)
		}
		if c.Endpoint != nil || c.PersistentKeepaliveInterval != nil || c.PresharedKey != nil {
			t.Fatalf("seuls la clé et le /32 sont posés : %+v", c)
		}
	}
	if p.Config.PrivateKey != nil || p.Config.ReplacePeers || p.Config.ListenPort != nil {
		t.Fatal("l'interface elle-même ne doit jamais être touchée")
	}
}

func TestRienAFaire(t *testing.T) {
	a := pair(t, "10.213.1.1")
	if p := Planifier([]Pair{a}, []wgtypes.Peer{actuel(a, "10.213.1.1/32")}, false); !p.Vide() {
		t.Fatalf("%+v", p)
	}
}

func TestGardeBaseVide(t *testing.T) {
	// Base vide, un seul pair : c'est la révocation du dernier routeur, elle passe.
	a := pair(t, "10.213.1.1")
	if p := Planifier(nil, []wgtypes.Peer{actuel(a, "10.213.1.1/32")}, false); len(p.Retraits) != 1 || p.Anomalie != "" {
		t.Fatalf("dernier routeur : %+v", p)
	}
	// Base vide, 10 pairs : au-delà du seuil (5), rien n'est retiré.
	var actuels []wgtypes.Peer
	for i := 0; i < 10; i++ {
		x := pair(t, netip.AddrFrom4([4]byte{10, 213, 3, byte(i + 1)}).String())
		actuels = append(actuels, actuel(x, x.IP.String()+"/32"))
	}
	if p := Planifier(nil, actuels, false); len(p.Retraits) != 0 || p.Anomalie == "" || !p.Vide() {
		t.Fatalf("base vide : %+v", p)
	}
	// Ajouts toujours appliqués, même quand la garde retient les retraits.
	n := pair(t, "10.213.1.2")
	if p := Planifier([]Pair{n}, actuels, false); len(p.Ajouts) != 1 || len(p.Retraits) != 0 || p.Anomalie == "" {
		t.Fatalf("retrait massif : %+v", p)
	}
}

func TestSeuilRetraits(t *testing.T) {
	for _, c := range []struct{ actuels, seuil int }{{0, 5}, {10, 5}, {25, 5}, {30, 6}, {100, 20}, {500, 100}} {
		if s := SeuilRetraits(c.actuels); s != c.seuil {
			t.Fatalf("%d pairs : seuil %d, attendu %d", c.actuels, s, c.seuil)
		}
	}
	// 30 pairs, 6 retraits : passe ; 7 : retenus, sauf garde levée.
	var actuels []wgtypes.Peer
	var voulus []Pair
	for i := 0; i < 30; i++ {
		x := pair(t, netip.AddrFrom4([4]byte{10, 213, 4, byte(i + 1)}).String())
		actuels = append(actuels, actuel(x, x.IP.String()+"/32"))
		voulus = append(voulus, x)
	}
	if p := Planifier(voulus[6:], actuels, false); len(p.Retraits) != 6 || p.Anomalie != "" {
		t.Fatalf("6 retraits sur 30 : %+v", p.Retraits)
	}
	if p := Planifier(voulus[7:], actuels, false); len(p.Retraits) != 0 || p.Anomalie == "" {
		t.Fatalf("7 retraits sur 30 : %+v", p.Retraits)
	}
	if p := Planifier(voulus[7:], actuels, true); len(p.Retraits) != 7 {
		t.Fatalf("garde levée : %+v", p.Retraits)
	}
}

func TestLirePairsRefuseToutOuRien(t *testing.T) {
	k := cle(t).String()
	k2 := cle(t).String()
	if _, err := LirePairs([][2]string{{k, "10.213.1.1"}, {k2, "10.213.1.2"}}); err != nil {
		t.Fatal(err)
	}
	for _, mauvais := range [][][2]string{
		{{k, "10.213.1.1"}, {"pas une clé", "10.213.1.2"}},
		{{k, "192.168.1.1"}},
		{{k, "10.213.1.1"}, {k, "10.213.1.2"}},
		{{k, "10.213.1.1"}, {k2, "10.213.1.1"}},
		{{k, "fe80::1"}},
	} {
		if _, err := LirePairs(mauvais); err == nil {
			t.Fatalf("accepté à tort : %v", mauvais)
		}
	}
}
