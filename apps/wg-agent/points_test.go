// Relevé des IP publiques des routeurs (revue de sécurité M7, migration 0032) : fonction pure.
package main

import (
	"net"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func TestPointsVus(t *testing.T) {
	maintenant := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	k := func() wgtypes.Key { x, _ := wgtypes.GeneratePrivateKey(); return x.PublicKey() }
	recent, vieux, sansMain, sansPoint, mappe, v6 := k(), k(), k(), k(), k(), k()
	pairs := []wgtypes.Peer{
		{PublicKey: recent, Endpoint: &net.UDPAddr{IP: net.ParseIP("203.0.113.7"), Port: 40000}, LastHandshakeTime: maintenant.Add(-2 * time.Minute)},
		{PublicKey: vieux, Endpoint: &net.UDPAddr{IP: net.ParseIP("203.0.113.8"), Port: 40000}, LastHandshakeTime: maintenant.Add(-4 * time.Minute)},
		{PublicKey: sansMain, Endpoint: &net.UDPAddr{IP: net.ParseIP("203.0.113.9"), Port: 40000}},
		{PublicKey: sansPoint, LastHandshakeTime: maintenant},
		{PublicKey: mappe, Endpoint: &net.UDPAddr{IP: net.ParseIP("::ffff:198.51.100.4"), Port: 1}, LastHandshakeTime: maintenant},
		{PublicKey: v6, Endpoint: &net.UDPAddr{IP: net.ParseIP("2001:db8:1:2::5"), Port: 1}, LastHandshakeTime: maintenant},
	}
	got := PointsVus(pairs, maintenant)
	if len(got) != 3 {
		t.Fatalf("3 points attendus (récent, IPv4 notée en IPv6, IPv6) : %+v", got)
	}
	attendu := map[string]string{recent.String(): "203.0.113.7", mappe.String(): "198.51.100.4", v6.String(): "2001:db8:1:2::5"}
	for _, p := range got {
		if attendu[p.Cle] != p.IP.String() {
			t.Fatalf("point %s : %s, attendu %s", p.Cle[:8], p.IP, attendu[p.Cle])
		}
	}
	// Une poignée de main datée du futur (horloge fausse) est ignorée.
	futur := []wgtypes.Peer{{PublicKey: recent, Endpoint: &net.UDPAddr{IP: net.ParseIP("203.0.113.7")}, LastHandshakeTime: maintenant.Add(2 * time.Minute)}}
	if len(PointsVus(futur, maintenant)) != 0 {
		t.Fatal("poignée de main future acceptée")
	}
}
