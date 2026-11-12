// ADR 0012 §5 : prisma/schema.prisma est exactement ce que `prisma db pull` tire de la base migrée.
// `db pull --print` échoue avec un prisma.config.ts (Prisma 7.10.1, constaté le 12/11/2026) : le
// test tire donc dans une copie temporaire, puis compare octet pour octet.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { URL_ADMIN } from "./aide.ts";

test("schema.prisma ne diverge pas de la base", () => {
  const versionne = fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url));
  const copie = join(mkdtempSync(join(tmpdir(), "wakatnet-prisma-")), "schema.prisma");
  copyFileSync(versionne, copie);
  execFileSync("npx", ["prisma", "db", "pull"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, WAKATNET_PRISMA_PULL_URL: URL_ADMIN, WAKATNET_PRISMA_SCHEMA: copie },
    stdio: ["ignore", "ignore", "pipe"],
  });
  assert.equal(readFileSync(copie, "utf8"), readFileSync(versionne, "utf8"),
               "migration ajoutée sans `prisma db pull` : régénérer prisma/schema.prisma");
});
