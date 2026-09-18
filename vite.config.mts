import { cp } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);

/*
 * Excalidraw registers its scene fonts at runtime with plain URL strings the
 * bundler cannot follow, so without this they never make it into the build and
 * the canvas silently falls back to a system serif. Served from node_modules in
 * dev, copied next to index.html for a build; src/asset-path.ts points the
 * runtime at them.
 */
const excalidrawFonts = (): Plugin => {
  // The package does not export ./package.json; the fonts sit next to the entry.
  const fontsDir = path.join(
    path.dirname(require.resolve("@excalidraw/excalidraw")),
    "fonts",
  );

  return {
    name: "excalidraw-fonts",

    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (!url.startsWith("/fonts/")) {
          return next();
        }
        let rel: string;
        try {
          rel = decodeURIComponent(url.slice("/fonts/".length));
        } catch {
          res.statusCode = 400; // a stray % in the path
          return res.end();
        }
        // path.relative, not startsWith: a prefix check accepts `<fontsDir>-other/…`.
        const file = path.join(fontsDir, rel);
        const inside = path.relative(fontsDir, file);
        if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
          res.statusCode = 403;
          return res.end();
        }
        res.setHeader("Content-Type", "font/woff2");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        require("node:fs").createReadStream(file).on("error", next).pipe(res);
      });
    },

    async closeBundle() {
      await cp(fontsDir, path.resolve("dist/fonts"), { recursive: true });
    },
  };
};

export default defineConfig({
  plugins: [react(), excalidrawFonts()],
  // Electron loads the built files over file://, so assets must be relative.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5178,
    strictPort: true,
  },
  optimizeDeps: {
    esbuildOptions: {
      // Excalidraw uses arbitrary module namespace identifier names.
      target: "es2022",
      treeShaking: true,
    },
  },
});
