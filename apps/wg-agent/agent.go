// WAKATNET — wg-agent : un tour de réconciliation, et la boucle LISTEN/NOTIFY (ADR 0012 §1).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// Interface : la part de wgctrl dont l'agent a besoin (noyau ou wireguard-go, même API).
type Interface interface {
	Device(nom string) (*wgtypes.Device, error)
	ConfigureDevice(nom string, cfg wgtypes.Config) error
}

type Agent struct {
	WG            Interface
	Nom           string
	RetraitMassif bool
	Journal       *slog.Logger
}

func court(k wgtypes.Key) string { return k.String()[:8] + "…" }

// Tour : lit l'état voulu, puis applique. Une erreur de lecture ne change rien à l'interface.
func (a *Agent) Tour(ctx context.Context, lire func(context.Context) ([]Pair, error)) (Plan, error) {
	voulus, err := lire(ctx)
	if err != nil {
		return Plan{}, fmt.Errorf("lecture des pairs : %w (aucun changement)", err)
	}
	dev, err := a.WG.Device(a.Nom)
	if err != nil {
		return Plan{}, fmt.Errorf("interface %s : %w", a.Nom, err)
	}
	p := Planifier(voulus, dev.Peers, a.RetraitMassif)
	if p.Anomalie != "" {
		a.Journal.Error("ANOMALIE", "detail", p.Anomalie)
	}
	if p.Vide() {
		return p, nil
	}
	if err := a.WG.ConfigureDevice(a.Nom, p.Config); err != nil {
		return p, fmt.Errorf("configuration de %s : %w", a.Nom, err)
	}
	for _, x := range p.Ajouts {
		a.Journal.Info("pair ajouté", "cle", court(x.Cle), "ip", x.IP.String())
	}
	for _, x := range p.MisesAJour {
		a.Journal.Info("pair corrigé", "cle", court(x.Cle), "ip", x.IP.String())
	}
	for _, k := range p.Retraits {
		a.Journal.Info("pair retiré", "cle", court(k))
	}
	return p, nil
}

// LireBase : SELECT sur app.wg_pairs() (rôle wk_wg, EXECUTE seul).
func LireBase(conn *pgx.Conn) func(context.Context) ([]Pair, error) {
	return func(ctx context.Context) ([]Pair, error) {
		rows, err := conn.Query(ctx, "SELECT public_key, overlay_ip FROM app.wg_pairs()")
		if err != nil {
			return nil, err
		}
		var lignes [][2]string
		for rows.Next() {
			var l [2]string
			if err := rows.Scan(&l[0], &l[1]); err != nil {
				rows.Close()
				return nil, err
			}
			lignes = append(lignes, l)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return LirePairs(lignes)
	}
}

// Boucle : connexion (variables PG* de l'environnement), LISTEN, un tour à chaque notification
// et au moins toutes les `periode`. Base perdue : reconnexion après `pause`, aucun retrait.
func (a *Agent) Boucle(ctx context.Context, periode, pause time.Duration) {
	for ctx.Err() == nil {
		if err := a.session(ctx, periode); err != nil && ctx.Err() == nil {
			a.Journal.Error("base", "erreur", err.Error())
			select {
			case <-ctx.Done():
			case <-time.After(pause):
			}
		}
	}
}

func (a *Agent) session(ctx context.Context, periode time.Duration) error {
	cfg, err := pgx.ParseConfig("")
	if err != nil {
		return err
	}
	cfg.RuntimeParams["application_name"] = "wakatnet-wg-agent"
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(ctx, "LISTEN wakatnet_pairs"); err != nil {
		return err
	}
	lire := LireBase(conn)
	for {
		if _, err := a.Tour(ctx, lire); err != nil {
			a.Journal.Error("tour", "erreur", err.Error())
			if errors.Is(err, context.Canceled) {
				return nil
			}
		}
		attente, annuler := context.WithTimeout(ctx, periode)
		_, err := conn.WaitForNotification(attente)
		annuler()
		if err != nil && !errors.Is(err, context.DeadlineExceeded) {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
	}
}
