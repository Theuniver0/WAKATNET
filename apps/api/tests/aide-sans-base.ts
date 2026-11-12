// Données de test qui n'exigent pas de base (tests du texte des scripts, de la configuration).
import type { Noeud } from "../src/config.ts";

/** Nœuds fictifs : clés publiques de forme valide, IP de documentation (RFC 5737). */
export const NOEUDS: Noeud[] = [
  { nom: "A", overlay: "10.213.0.1", cle: "A".repeat(43) + "=", endpoint: "192.0.2.10", port: 51820 },
  { nom: "B", overlay: "10.213.0.2", cle: "B".repeat(42) + "E=", endpoint: "198.51.100.20", port: 51820 },
];
