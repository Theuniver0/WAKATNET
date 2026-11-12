import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Servi par l'API sous /tableau/ (ADR 0014 §5) : même origine, CSP script-src 'self'; style-src 'self'.
export default defineConfig({
  base: "/tableau/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0, cssCodeSplit: false },
});
