// WAKATNET — sonde lancée À LA PLACE de l'API par la VRAIE unité wakatnet-api.service (essais/unite-api.sh).
// Elle exerce les familles d'appels système que l'API utilise (relevé strace, ADR 0016) sous le filtre de l'unité,
// et rend sur GET /sonde un JSON { ok, etapes, seccomp }. Aucune dépendance : modules de Node seulement.
import http from "node:http";
import { scrypt, randomBytes } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { Worker } from "node:worker_threads";
import { gzipSync, gunzipSync } from "node:zlib";
import { promisify } from "node:util";

const hote = process.env.WAKATNET_API_HOTE ?? "127.0.0.1";
const port = Number(process.env.WAKATNET_API_PORT ?? 3000);

async function sonder(): Promise<Record<string, string>> {
  const etapes: Record<string, string> = {};
  const essai = async (nom: string, f: () => Promise<unknown>) => {
    try { await f(); etapes[nom] = "ok"; } catch (e) { etapes[nom] = `ÉCHEC ${(e as Error).message}`; }
  };
  await essai("scrypt", async () => { await promisify(scrypt)("mot", randomBytes(16), 64, { N: 16384, r: 8, p: 1 }); });
  await essai("fs", async () => {
    const f = join(tmpdir(), `sonde-${process.pid}`);
    await fs.writeFile(f, "x"); if ((await fs.readFile(f, "utf8")) !== "x") throw new Error("lecture"); await fs.unlink(f);
  });
  await essai("dns", async () => { await lookup("localhost"); });
  await essai("worker", () => new Promise<void>((ok, ko) => {
    const w = new Worker("require('node:worker_threads').parentPort.postMessage(6*7)", { eval: true });
    w.once("message", (m) => (m === 42 ? ok() : ko(new Error(String(m))))); w.once("error", ko);
  }));
  await essai("zlib", async () => { if (gunzipSync(gzipSync("wakatnet")).toString() !== "wakatnet") throw new Error("zlib"); });
  // Module WebAssembly minimal : (func (export "f") (result i32) i32.const 42).
  await essai("wasm", async () => {
    const octets = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,5,1,1,102,0,0,10,6,1,4,0,65,42,11]);
    const { instance } = await WebAssembly.instantiate(octets);
    if ((instance.exports.f as () => number)() !== 42) throw new Error("wasm");
  });
  await essai("fetch", async () => {
    const r = await fetch(`http://${hote}:${port}/ping`); if ((await r.text()) !== "pong") throw new Error("fetch");
  });
  return etapes;
}

http.createServer(async (req, res) => {
  if (req.url === "/ping") { res.end("pong"); return; }
  if (req.url !== "/sonde") { res.statusCode = 404; res.end(); return; }
  const etapes = await sonder();
  // Seccomp : 2 = filtre actif. /proc/self reste lisible sous ProtectProc=invisible (processus de l'unité).
  const seccomp = /^Seccomp:\s*(\d+)/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1] ?? "?";
  const ok = Object.values(etapes).every((v) => v === "ok") && seccomp === "2";
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok, etapes, seccomp, node: process.version }));
}).listen(port, hote);
