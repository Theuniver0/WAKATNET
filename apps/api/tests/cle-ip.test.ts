// Clé de limitation par source (revue de sécurité M2 et M7, migration 0031).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleIp, cleSource } from "../src/cle-ip.ts";

test("IPv4 telle quelle ; IPv6 ramenée au /64 ; IPv4 notée en IPv6 ramenée à l'IPv4 ; illisible → un seul budget", () => {
  assert.equal(cleIp("203.0.113.7"), "203.0.113.7");
  assert.equal(cleIp("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(cleIp("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(cleIp("2001:DB8:1:2::ffff"), "2001:db8:1:2::/64", "même /64, autre interface : même clé");
  assert.equal(cleIp("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(cleIp("2001:0db8:0001:0002::"), "2001:db8:1:2::/64");
  assert.equal(cleIp("::1"), "0:0:0:0::/64");
  assert.equal(cleIp("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(cleIp("64:ff9b::192.0.2.33"), "64:ff9b:0:0::/64");
  for (const x of [undefined, "", "pas une ip", "1.2.3.4.5", "999.1.1.1"]) assert.equal(cleIp(x), "?", String(x));
  assert.notEqual(cleIp("2001:db8:1:2::1"), cleIp("2001:db8:1:3::1"), "deux /64 : deux clés");
});

test("source gardée en base : HMAC du jour, stable dans la journée, différent le lendemain, sans IP en clair", () => {
  const cle = Buffer.alloc(32, 7);
  const j1 = new Date("2026-11-20T08:00:00Z"), j1b = new Date("2026-11-20T23:59:00Z"), j2 = new Date("2026-11-21T00:00:00Z");
  const s = cleSource("2001:db8:1:2::5", cle, j1);
  assert.match(s, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(cleSource("2001:db8:1:2::9", cle, j1b), s, "même /64, même jour");
  assert.notEqual(cleSource("2001:db8:1:2::5", cle, j2), s, "autre jour : non reliable");
  assert.notEqual(cleSource("2001:db8:1:3::5", cle, j1), s);
  assert.equal(cleSource("203.0.113.7", null), "203.0.113.7", "sans clé (développement) : la clé de source");
});
