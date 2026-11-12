// WAKATNET — wg-agent : planification de la réconciliation des pairs (ADR 0012 §1).
// Ticket : .scratch/phase-2-multi-proprietaires/issues/05-wg-agent.md
//
// Fonction pure : état voulu (base) + état actuel (interface) → changements à appliquer.
// La clé privée de l'interface n'est jamais lue ni écrite : seuls les pairs changent.
package main

import (
	"fmt"
	"net"
	"net/netip"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// Pair voulu : un routeur actif, sa clé publique et son /32 dans l'overlay.
type Pair struct {
	Cle wgtypes.Key
	IP  netip.Addr
}

// Plan : configuration à passer à ConfigureDevice et bilan, pour le journal.
type Plan struct {
	Config     wgtypes.Config
	Ajouts     []Pair
	MisesAJour []Pair
	Retraits   []wgtypes.Key
	// Anomalie : non vide quand la garde anti-effacement a retenu des retraits.
	Anomalie string
}

// Vide : rien à appliquer.
func (p Plan) Vide() bool { return len(p.Config.Peers) == 0 }

var overlay = netip.MustParsePrefix("10.213.0.0/16")

// LirePairs valide les lignes de app.wg_pairs(). Une seule ligne invalide fait échouer la
// lecture entière : le tour ne retire alors rien (une ligne ignorée ferait retirer son pair).
func LirePairs(lignes [][2]string) ([]Pair, error) {
	pairs := make([]Pair, 0, len(lignes))
	vues := map[wgtypes.Key]bool{}
	ips := map[netip.Addr]bool{}
	for i, l := range lignes {
		k, err := wgtypes.ParseKey(l[0])
		if err != nil {
			return nil, fmt.Errorf("ligne %d : clé publique illisible", i)
		}
		ip, err := netip.ParseAddr(l[1])
		if err != nil || !ip.Is4() || !overlay.Contains(ip) {
			return nil, fmt.Errorf("ligne %d : adresse hors de l'overlay", i)
		}
		if vues[k] || ips[ip] {
			return nil, fmt.Errorf("ligne %d : clé ou adresse en double", i)
		}
		vues[k], ips[ip] = true, true
		pairs = append(pairs, Pair{Cle: k, IP: ip})
	}
	return pairs, nil
}

func trente2(ip netip.Addr) net.IPNet {
	b := ip.As4()
	return net.IPNet{IP: net.IPv4(b[0], b[1], b[2], b[3]).To4(), Mask: net.CIDRMask(32, 32)}
}

// exactement : AllowedIPs du pair = ce seul /32 (SPEC §6.1 : rien de plus).
func exactement(actuel []net.IPNet, ip netip.Addr) bool {
	if len(actuel) != 1 {
		return false
	}
	voulu := trente2(ip)
	return actuel[0].IP.Equal(voulu.IP) && actuel[0].Mask.String() == voulu.Mask.String()
}

// SeuilRetraits : au-delà de max(5, 20 % des pairs actuels) retraits en un tour, la garde retient.
func SeuilRetraits(actuels int) int {
	s := actuels / 5
	if s < 5 {
		s = 5
	}
	return s
}

// Planifier compare voulu et actuel. retraitMassif lève la garde (WAKATNET_WG_RETRAIT_MASSIF=1).
func Planifier(voulus []Pair, actuels []wgtypes.Peer, retraitMassif bool) Plan {
	var p Plan
	parCle := make(map[wgtypes.Key]wgtypes.Peer, len(actuels))
	for _, a := range actuels {
		parCle[a.PublicKey] = a
	}
	voulusCles := make(map[wgtypes.Key]bool, len(voulus))
	for _, v := range voulus {
		voulusCles[v.Cle] = true
		a, existe := parCle[v.Cle]
		if existe && exactement(a.AllowedIPs, v.IP) {
			continue
		}
		if existe {
			p.MisesAJour = append(p.MisesAJour, v)
		} else {
			p.Ajouts = append(p.Ajouts, v)
		}
		p.Config.Peers = append(p.Config.Peers, wgtypes.PeerConfig{
			PublicKey:         v.Cle,
			ReplaceAllowedIPs: true,
			AllowedIPs:        []net.IPNet{trente2(v.IP)},
		})
	}
	var retraits []wgtypes.Key
	for _, a := range actuels {
		if !voulusCles[a.PublicKey] {
			retraits = append(retraits, a.PublicKey)
		}
	}
	// Une seule règle, base vide comprise : au-delà du seuil, rien n'est retiré. Une base vide ou
	// erronée ne peut donc couper qu'au plus 5 routeurs (ou 20 %) ; révoquer le DERNIER routeur
	// d'un nœud reste possible.
	switch {
	case len(retraits) == 0:
	case len(retraits) > SeuilRetraits(len(actuels)) && !retraitMassif:
		p.Anomalie = fmt.Sprintf("%d retraits demandés en un tour (seuil %d) : aucun retrait ; poser WAKATNET_WG_RETRAIT_MASSIF=1 si c'est voulu",
			len(retraits), SeuilRetraits(len(actuels)))
	default:
		p.Retraits = retraits
		for _, k := range retraits {
			p.Config.Peers = append(p.Config.Peers, wgtypes.PeerConfig{PublicKey: k, Remove: true})
		}
	}
	return p
}
