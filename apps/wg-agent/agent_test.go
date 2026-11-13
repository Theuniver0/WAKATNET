// Purge des IP des routeurs (T10, migration 0032) : l'agent appelle app.wg_points_noter à chaque tour,
// même sans pair vu, même quand la réconciliation ou la lecture de l'interface échoue. Tests sans base ni WireGuard.
package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

type faux struct {
	pairs     []wgtypes.Peer
	errDevice error
	errConfig error
}

func (f *faux) Device(string) (*wgtypes.Device, error) {
	if f.errDevice != nil {
		return nil, f.errDevice
	}
	return &wgtypes.Device{Peers: f.pairs}, nil
}

func (f *faux) ConfigureDevice(string, wgtypes.Config) error { return f.errConfig }

type espion struct {
	appels int
	points []PointVu
}

func (e *espion) noter(_ context.Context, p []PointVu) (int, error) {
	e.appels++
	e.points = p
	return 0, nil
}

func agentDeTest(f *faux) *Agent {
	return &Agent{WG: f, Nom: "wgt0", Journal: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func TestNoterSansPointPurgeQuandMeme(t *testing.T) {
	e := &espion{}
	if err := agentDeTest(&faux{}).Noter(context.Background(), e.noter); err != nil {
		t.Fatal(err)
	}
	if e.appels != 1 || len(e.points) != 0 {
		t.Fatalf("wg_points_noter doit être appelée avec des tableaux vides (purge) : %d appel(s), %d point(s)", e.appels, len(e.points))
	}
}

func TestNoterInterfaceIllisiblePurgeQuandMeme(t *testing.T) {
	e := &espion{}
	err := agentDeTest(&faux{errDevice: errors.New("absente")}).Noter(context.Background(), e.noter)
	if err == nil {
		t.Fatal("l'erreur de lecture de l'interface doit remonter")
	}
	if e.appels != 1 || len(e.points) != 0 {
		t.Fatalf("interface illisible : purge attendue sans aucun point, %d appel(s), %d point(s)", e.appels, len(e.points))
	}
}

func TestCycleNoteMemeSiLeTourEchoue(t *testing.T) {
	k, _ := wgtypes.GeneratePrivateKey()
	pair := wgtypes.Peer{PublicKey: k.PublicKey(), Endpoint: &net.UDPAddr{IP: net.ParseIP("203.0.113.7"), Port: 1}, LastHandshakeTime: time.Now()}
	lireEnErreur := func(context.Context) ([]Pair, error) { return nil, errors.New("base indisponible") }

	e := &espion{}
	if fin := agentDeTest(&faux{pairs: []wgtypes.Peer{pair}}).cycle(context.Background(), lireEnErreur, e.noter); fin {
		t.Fatal("une erreur de lecture ne termine pas la session")
	}
	if e.appels != 1 || len(e.points) != 1 {
		t.Fatalf("tour en échec : points attendus quand même, %d appel(s), %d point(s)", e.appels, len(e.points))
	}

	// Contexte annulé : la session s'arrête, rien n'est écrit.
	ctx, annuler := context.WithCancel(context.Background())
	annuler()
	lireAnnule := func(ctx context.Context) ([]Pair, error) { return nil, ctx.Err() }
	e = &espion{}
	if fin := agentDeTest(&faux{}).cycle(ctx, lireAnnule, e.noter); !fin || e.appels != 0 {
		t.Fatalf("contexte annulé : fin=%v, %d appel(s)", fin, e.appels)
	}
}
