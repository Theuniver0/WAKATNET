//go:build integration

// Tests sur une VRAIE interface WireGuard (wireguard-go, espace utilisateur : le conteneur de
// test n'a pas le module du noyau ; wgctrl parle aux deux par la même API). Lancés par
// tests/run.sh, en root, avec /dev/net/tun. Ticket 05 (et 06 pour la révocation).
package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.zx2c4.com/wireguard/wgctrl"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

const iface = "wgt0"

type banc struct {
	wg    *wgctrl.Client
	privK wgtypes.Key
	index int
	port  int
}

func ouvrir(t *testing.T) *banc {
	t.Helper()
	cmd := exec.Command("wireguard-go", "-f", iface)
	// Sur Linux, wireguard-go refuse de démarrer sans cette variable (le module du noyau est préféré).
	cmd.Env = append(os.Environ(), "WG_I_PREFER_BUGGY_USERSPACE_TO_POLISHED_KMOD=1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("wireguard-go : %v", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	wg, err := wgctrl.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { wg.Close() })
	for i := 0; ; i++ {
		if _, err := wg.Device(iface); err == nil {
			break
		}
		if i > 50 {
			t.Fatal("interface wireguard-go absente")
		}
		time.Sleep(100 * time.Millisecond)
	}
	// wireguard-go n'ouvre son port UDP qu'une fois l'interface montée.
	if out, err := exec.Command("ip", "link", "set", iface, "up").CombinedOutput(); err != nil {
		t.Fatalf("ip link set up : %v %s", err, out)
	}
	k, _ := wgtypes.GeneratePrivateKey()
	port := 51820
	if err := wg.ConfigureDevice(iface, wgtypes.Config{PrivateKey: &k, ListenPort: &port}); err != nil {
		t.Fatal(err)
	}
	ni, err := net.InterfaceByName(iface)
	if err != nil {
		t.Fatal(err)
	}
	// Le port relevé ici sert de référence : il ne doit plus changer (wireguard-go peut le
	// rendre à 0 dans ce banc, ce qui ne change rien à ce que l'on vérifie).
	d, err := wg.Device(iface)
	if err != nil || d.PrivateKey != k {
		t.Fatalf("configuration initiale : %v %v", d, err)
	}
	return &banc{wg: wg, privK: k, index: ni.Index, port: d.ListenPort}
}

func (b *banc) pairs(t *testing.T) map[wgtypes.Key]string {
	t.Helper()
	d, err := b.wg.Device(iface)
	if err != nil {
		t.Fatal(err)
	}
	m := map[wgtypes.Key]string{}
	for _, p := range d.Peers {
		s := ""
		for _, a := range p.AllowedIPs {
			s += a.String() + " "
		}
		m[p.PublicKey] = s
	}
	return m
}

// intacte : l'interface n'a été ni recréée ni reconfigurée (index, clé privée, port).
func (b *banc) intacte(t *testing.T) {
	t.Helper()
	d, _ := b.wg.Device(iface)
	ni, _ := net.InterfaceByName(iface)
	if d.PrivateKey != b.privK || ni.Index != b.index || d.ListenPort != b.port {
		t.Fatalf("l'interface a été recréée ou sa configuration propre a changé : clé %v, index %d/%d, port %d",
			d.PrivateKey == b.privK, ni.Index, b.index, d.ListenPort)
	}
}

func journal() *slog.Logger {
	if os.Getenv("WAKATNET_TEST_JOURNAL") != "" {
		return slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestReconciliationSurInterfaceReelle(t *testing.T) {
	b := ouvrir(t)
	a := &Agent{WG: b.wg, Nom: iface, Journal: journal()}
	p1, p2 := pair(t, "10.213.1.1"), pair(t, "10.213.1.2")
	voulus := []Pair{p1, p2}
	lire := func(context.Context) ([]Pair, error) { return voulus, nil }

	if _, err := a.Tour(context.Background(), lire); err != nil {
		t.Fatal(err)
	}
	if got := b.pairs(t); len(got) != 2 || got[p1.Cle] != "10.213.1.1/32 " || got[p2.Cle] != "10.213.1.2/32 " {
		t.Fatalf("pairs : %v", got)
	}
	// Pair étranger à la base, et pair élargi à la main : retiré, et ramené au /32.
	etranger := cle(t)
	_, large, _ := net.ParseCIDR("0.0.0.0/0")
	if err := b.wg.ConfigureDevice(iface, wgtypes.Config{Peers: []wgtypes.PeerConfig{
		{PublicKey: etranger},
		{PublicKey: p2.Cle, AllowedIPs: []net.IPNet{*large}},
	}}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Tour(context.Background(), lire); err != nil {
		t.Fatal(err)
	}
	if got := b.pairs(t); len(got) != 2 || got[p2.Cle] != "10.213.1.2/32 " {
		t.Fatalf("après correction : %v", got)
	}
	// Clé changée pour une même adresse (routeur réenrôlé) : ancien pair retiré, nouveau ajouté.
	p3 := Pair{Cle: cle(t), IP: p2.IP}
	voulus = []Pair{p1, p3}
	if _, err := a.Tour(context.Background(), lire); err != nil {
		t.Fatal(err)
	}
	if got := b.pairs(t); len(got) != 2 || got[p3.Cle] == "" || got[p2.Cle] != "" {
		t.Fatalf("clé changée : %v", got)
	}
	// Base injoignable : aucun changement.
	echec := func(context.Context) ([]Pair, error) { return nil, context.DeadlineExceeded }
	if _, err := a.Tour(context.Background(), echec); err == nil {
		t.Fatal("une erreur de lecture doit remonter")
	}
	if got := b.pairs(t); len(got) != 2 {
		t.Fatalf("base injoignable : %v", got)
	}
	b.intacte(t)
}

// Boucle complète contre PostgreSQL (rôle wk_wg) : NOTIFY → pair ajouté, puis révocation → pair
// retiré, chacun en moins de 2 s alors que le tour périodique est réglé à 60 s.
func TestBoucleNotifyEtRevocation(t *testing.T) {
	admin := os.Getenv("WAKATNET_TEST_ADMIN_URL")
	if admin == "" {
		t.Skip("WAKATNET_TEST_ADMIN_URL absent")
	}
	b := ouvrir(t)
	ctx, arreter := context.WithCancel(context.Background())
	defer arreter()
	a := &Agent{WG: b.wg, Nom: iface, Journal: journal()}
	go a.Boucle(ctx, 60*time.Second, 200*time.Millisecond)

	c, err := pgx.Connect(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(context.Background())
	var tenant, site int64
	if err := c.QueryRow(ctx, "INSERT INTO app.tenant (nom) VALUES ('wg-agent') RETURNING id").Scan(&tenant); err != nil {
		t.Fatal(err)
	}
	if err := c.QueryRow(ctx, "INSERT INTO app.site (tenant_id, nom) VALUES ($1, 's') RETURNING id", tenant).Scan(&site); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond) // premier tour et LISTEN posés
	k := cle(t)
	debut := time.Now()
	var routeur int64
	var ip string
	if err := c.QueryRow(ctx, `INSERT INTO app.router (tenant_id, site_id, overlay_ip, shortname, wg_public_key)
	                           SELECT $1, $2, coalesce(max(overlay_ip), '10.213.7.0'::inet) + 1, 'r-wg-agent-' || $1::bigint, $3
	                             FROM app.router WHERE overlay_ip << '10.213.7.0/24'::inet
	                           RETURNING id, host(overlay_ip) || '/32 '`, tenant, site, k.String()).Scan(&routeur, &ip); err != nil {
		t.Fatal(err)
	}
	attendre(t, 2*time.Second, func() bool { return b.pairs(t)[k] == ip })
	t.Logf("ajout appliqué en %v", time.Since(debut))

	debut = time.Now()
	if _, err := c.Exec(ctx, "UPDATE app.router SET actif = false WHERE id = $1", routeur); err != nil {
		t.Fatal(err)
	}
	attendre(t, 2*time.Second, func() bool { _, la := b.pairs(t)[k]; return !la })
	t.Logf("révocation appliquée en %v", time.Since(debut))
	b.intacte(t)
}

func attendre(t *testing.T, limite time.Duration, ok func() bool) {
	t.Helper()
	fin := time.Now().Add(limite)
	for !ok() {
		if time.Now().After(fin) {
			t.Fatalf("pas fait en %v", limite)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

var _ = netip.Addr{}

// Revue de sécurité M7 (migration 0032) : un « routeur » (second wireguard-go) fait une vraie poignée de main avec
// wg0 ; l'agent note son IP publique (ici 127.0.0.1) en base, et le portail la reconnaît comme celle du site.
func TestIPPubliqueDuRouteurNotee(t *testing.T) {
	admin := os.Getenv("WAKATNET_TEST_ADMIN_URL")
	if admin == "" {
		t.Skip("WAKATNET_TEST_ADMIN_URL absent")
	}
	b := ouvrir(t)
	ctx, arreter := context.WithCancel(context.Background())
	defer arreter()
	c, err := pgx.Connect(ctx, admin)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close(context.Background())
	var tenant, site, routeur int64
	if err := c.QueryRow(ctx, "INSERT INTO app.tenant (nom) VALUES ('wg-points') RETURNING id").Scan(&tenant); err != nil {
		t.Fatal(err)
	}
	if err := c.QueryRow(ctx, "INSERT INTO app.site (tenant_id, nom) VALUES ($1, 's') RETURNING id", tenant).Scan(&site); err != nil {
		t.Fatal(err)
	}
	kR, _ := wgtypes.GeneratePrivateKey()
	if err := c.QueryRow(ctx, `INSERT INTO app.router (tenant_id, site_id, overlay_ip, shortname, wg_public_key)
	                           SELECT $1, $2, coalesce(max(overlay_ip), '10.213.8.0'::inet) + 1, 'r-wg-points-' || $1::bigint, $3
	                             FROM app.router WHERE overlay_ip << '10.213.8.0/24'::inet
	                           RETURNING id`, tenant, site, kR.PublicKey().String()).Scan(&routeur); err != nil {
		t.Fatal(err)
	}

	// Le routeur : son propre wireguard-go, qui appelle wg0 sur 127.0.0.1 avec un keepalive d'une seconde.
	const nomR = "wgr0"
	cmd := exec.Command("wireguard-go", "-f", nomR)
	cmd.Env = append(os.Environ(), "WG_I_PREFER_BUGGY_USERSPACE_TO_POLISHED_KMOD=1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("wireguard-go (routeur) : %v", err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	for i := 0; ; i++ {
		if _, err := b.wg.Device(nomR); err == nil {
			break
		}
		if i > 50 {
			t.Fatal("interface du routeur absente")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if out, err := exec.Command("ip", "link", "set", nomR, "up").CombinedOutput(); err != nil {
		t.Fatalf("ip link set up : %v %s", err, out)
	}
	portR, ka := 51821, time.Second
	_, tout, _ := net.ParseCIDR("10.213.0.0/16")
	if err := b.wg.ConfigureDevice(nomR, wgtypes.Config{PrivateKey: &kR, ListenPort: &portR, Peers: []wgtypes.PeerConfig{{
		PublicKey: b.privK.PublicKey(), Endpoint: &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 51820},
		PersistentKeepaliveInterval: &ka, AllowedIPs: []net.IPNet{*tout},
	}}}); err != nil {
		t.Fatal(err)
	}

	a := &Agent{WG: b.wg, Nom: iface, Journal: journal()}
	go a.Boucle(ctx, time.Second, 200*time.Millisecond)
	debut := time.Now()
	attendre(t, 15*time.Second, func() bool {
		var ip *string
		_ = c.QueryRow(ctx, "SELECT host(ip_publique) FROM app.router WHERE id = $1", routeur).Scan(&ip)
		return ip != nil && *ip == "127.0.0.1"
	})
	t.Logf("IP publique du routeur notée en %v", time.Since(debut))
	var reconnu, autre bool
	if err := c.QueryRow(ctx, "SELECT app._depuis_routeur($1, '127.0.0.1'), app._depuis_routeur($1, '127.0.0.2')", site).Scan(&reconnu, &autre); err != nil {
		t.Fatal(err)
	}
	if !reconnu || autre {
		t.Fatalf("reconnaissance de l'IP du routeur : %v (attendu vrai), autre IP : %v (attendu faux)", reconnu, autre)
	}
	// Routeur révoqué : son IP ne vaut plus rien.
	if _, err := c.Exec(ctx, "UPDATE app.router SET actif = false WHERE id = $1", routeur); err != nil {
		t.Fatal(err)
	}
	if err := c.QueryRow(ctx, "SELECT app._depuis_routeur($1, '127.0.0.1')", site).Scan(&reconnu); err != nil || reconnu {
		t.Fatalf("routeur révoqué encore reconnu : %v %v", reconnu, err)
	}
	b.intacte(t)
}
