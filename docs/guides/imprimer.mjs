// WAKATNET — rend docs/guides/guide-pilote.html en PDF A4 : node docs/guides/imprimer.mjs
// Exige Playwright et Chromium (préinstallés sur le poste de l'agent ; ailleurs : npx playwright install chromium).
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ici = dirname(fileURLToPath(import.meta.url));
const navigateur = await chromium.launch();
try {
  const page = await navigateur.newPage();
  await page.goto(pathToFileURL(join(ici, "guide-pilote.html")).href, { waitUntil: "load" });
  await page.pdf({
    path: join(ici, "guide-pilote.pdf"), format: "A4", printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: "<span></span>",
    footerTemplate: '<div style="font-size:8pt;color:#5a6270;width:100%;text-align:center">WAKATNET — guide du pilote — page <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
  });
} finally {
  await navigateur.close();
}
console.log("docs/guides/guide-pilote.pdf");
