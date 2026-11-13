// Bornes de WAKATNET_WG_PERIODE_S : au-delà de 120 s, le budget propre au routeur (fraîcheur de 10 min,
// réécriture après 5 min, migration 0032) se perdrait par intermittence. Test sans base ni WireGuard.
package main

import "testing"

func TestLirePeriode(t *testing.T) {
	for v, attendu := range map[string]int{"": 30, "1": 1, "30": 30, "120": 120} {
		if n, err := lirePeriode(v); err != nil || n != attendu {
			t.Fatalf("%q : %d, %v ; attendu %d", v, n, err, attendu)
		}
	}
	for _, v := range []string{"0", "-5", "121", "3600", "abc", "30s", " 30"} {
		if n, err := lirePeriode(v); err == nil {
			t.Fatalf("%q accepté (%d) : 1 à 120 s seulement", v, n)
		}
	}
}
