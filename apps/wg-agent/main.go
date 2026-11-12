// WAKATNET — wg-agent : tient les pairs de wg0 alignés sur la base (SPEC §6.1, ADR 0012 §1).
//
// Environnement (EnvironmentFile systemd réservé à root) :
//   PGHOST, PGDATABASE, PGUSER=wk_wg, PGPASSWORD   connexion (libpq), jamais en argument
//   WAKATNET_WG_INTERFACE        interface gérée (défaut wg0)
//   WAKATNET_WG_PERIODE_S        tour périodique de filet (défaut 30)
//   WAKATNET_WG_RETRAIT_MASSIF   « 1 » lève la garde anti-effacement (à poser à la main)
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl"
)

func main() {
	journal := slog.New(slog.NewTextHandler(os.Stderr, nil))
	nom := os.Getenv("WAKATNET_WG_INTERFACE")
	if nom == "" {
		nom = "wg0"
	}
	periode := 30
	if v := os.Getenv("WAKATNET_WG_PERIODE_S"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 3600 {
			journal.Error("WAKATNET_WG_PERIODE_S : entier de 1 à 3600")
			os.Exit(1)
		}
		periode = n
	}
	wg, err := wgctrl.New()
	if err != nil {
		journal.Error("wgctrl", "erreur", err.Error())
		os.Exit(1)
	}
	defer wg.Close()
	if _, err := wg.Device(nom); err != nil {
		journal.Error("interface introuvable : wg-agent ne la crée jamais", "interface", nom, "erreur", err.Error())
		os.Exit(1)
	}
	ctx, arreter := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer arreter()
	a := &Agent{WG: wg, Nom: nom, RetraitMassif: os.Getenv("WAKATNET_WG_RETRAIT_MASSIF") == "1", Journal: journal}
	journal.Info("démarrage", "interface", nom, "periode_s", periode, "retrait_massif", a.RetraitMassif)
	a.Boucle(ctx, time.Duration(periode)*time.Second, 5*time.Second)
}
