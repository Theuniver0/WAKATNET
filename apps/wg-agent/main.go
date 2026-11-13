// WAKATNET — wg-agent : tient les pairs de wg0 alignés sur la base (SPEC §6.1, ADR 0012 §1).
//
// Environnement (EnvironmentFile systemd réservé à root) :
//   PGHOST, PGDATABASE, PGUSER=wk_wg, PGPASSWORD   connexion (libpq), jamais en argument
//   WAKATNET_WG_INTERFACE        interface gérée (défaut wg0)
//   WAKATNET_WG_PERIODE_S        tour périodique de filet, de 1 à 120 s (défaut 30) ; au-delà, refus au démarrage :
//                                le budget propre au routeur (fraîcheur de 10 min, réécriture après 5 min,
//                                migration 0032, ADR 0016 M7) se perdrait par intermittence
//   WAKATNET_WG_RETRAIT_MASSIF   « 1 » lève la garde anti-effacement (à poser à la main)
package main

import (
	"context"
	"fmt"
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
	periode, err := lirePeriode(os.Getenv("WAKATNET_WG_PERIODE_S"))
	if err != nil {
		journal.Error(err.Error())
		os.Exit(1)
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

// periodeMax : au-delà, le relevé des IP des routeurs (réécrites après 5 min, jugées fraîches 10 min) prendrait du
// retard sur la fenêtre de fraîcheur, et le budget propre au routeur se perdrait par intermittence (ADR 0016 M7).
const periodeMax = 120

// lirePeriode : valeur de WAKATNET_WG_PERIODE_S, en secondes ; vide = 30.
func lirePeriode(v string) (int, error) {
	if v == "" {
		return 30, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 || n > periodeMax {
		return 0, fmt.Errorf("WAKATNET_WG_PERIODE_S=%q refusée : entier de 1 à %d s attendu (au-delà, le budget "+
			"propre au routeur se perd par intermittence, ADR 0016 M7)", v, periodeMax)
	}
	return n, nil
}
