/*
 * Regenerates test/fixtures/: real Excalidraw exports at 2×, dark and
 * transparent, which the image round-trip test measures against.
 *
 *   npx vite                       # in another terminal
 *   npx electron tools/make-fixtures.cjs
 *
 * It runs the app in dev mode, where src/App.tsx exposes Excalidraw's own
 * exporters as window.__exdExport.
 */
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "test", "fixtures");
const WORK = path.join(__dirname, ".out", "fixtures-run");

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, "userData"), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
app.setName("Excalidraw Desktop");
app.setPath("userData", path.join(WORK, "userData"));

const rect = (id, x, y, backgroundColor) => ({
  id, type: "rectangle", x, y, width: 200, height: 150, angle: 0,
  strokeColor: "#1e1e1e", backgroundColor, fillStyle: "solid",
  strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100,
  groupIds: [], frameId: null, roundness: null, seed: 1, version: 1,
  versionNonce: 1, isDeleted: false, boundElements: null, updated: 1,
  link: null, locked: false,
});
const ELEMENTS = [rect("r1", 0, 0, "#a5d8ff"), rect("r2", 260, 60, "#ffec99")];

const seed = path.join(WORK, "seed.excalidraw");
fs.writeFileSync(seed, JSON.stringify({
  type: "excalidraw", version: 2, source: "test", elements: ELEMENTS,
  appState: { viewBackgroundColor: "#ffffff" }, files: {},
}));
fs.writeFileSync(path.join(WORK, "userData", "state.json"), JSON.stringify({
  openPaths: [seed], activePath: seed, sidebarCollapsed: false,
}));

require(path.join(ROOT, "electron", "main.cjs"));

/** [file, scale, background, darkMode] */
const WANTED = [
  ["scale2.excalidraw.png", 2, true, false],
  ["plain.excalidraw.png", 1, true, false],
  ["transparent.excalidraw.png", 1, false, false],
  ["dark.excalidraw.png", 2, true, true],
  ["scale3.excalidraw.svg", 3, true, false],
  ["darktransparent.excalidraw.svg", 1, false, true],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let failed = false;
  try {
    await sleep(0);
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    if (wc.isLoading()) {
      await new Promise((r) => wc.once("did-finish-load", r));
    }
    const js = (code) => wc.executeJavaScript(code, true);
    const start = Date.now();
    while (Date.now() - start < 30000 && !(await js("!!window.__exdExport"))) {
      await sleep(200);
    }
    if (!(await js("!!window.__exdExport"))) {
      throw new Error("window.__exdExport missing — is vite running and this a dev build?");
    }

    for (const [name, scale, background, darkMode] of WANTED) {
      const isPng = name.endsWith(".png");
      const base64 = await js(`(async () => {
        const { exportToBlob, exportToSvg } = window.__exdExport;
        const elements = ${JSON.stringify(ELEMENTS)};
        const appState = {
          viewBackgroundColor: "#ffffff",
          exportBackground: ${background},
          exportWithDarkMode: ${darkMode},
          exportScale: ${scale},
          exportEmbedScene: true,
        };
        const toBase64 = async (blob) => {
          const buf = new Uint8Array(await blob.arrayBuffer());
          let s = "";
          for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          return btoa(s);
        };
        if (${isPng}) {
          // Excalidraw's own app exports through the scale-aware path; the utils
          // wrapper only honours a scale when getDimensions says so.
          const blob = await exportToBlob({
            elements, appState, files: {}, mimeType: "image/png",
            getDimensions: (w, h) => ({ width: Math.trunc(w * ${scale}), height: Math.trunc(h * ${scale}), scale: ${scale} }),
          });
          return await toBase64(blob);
        }
        const svg = await exportToSvg({ elements, appState, files: {} });
        return btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(svg))));
      })()`);
      fs.writeFileSync(path.join(OUT, name), Buffer.from(base64, "base64"));
      console.log("wrote", path.relative(ROOT, path.join(OUT, name)));
    }
  } catch (err) {
    failed = true;
    console.log("ERROR", err?.message ?? String(err));
  }
  app.exit(failed ? 1 : 0);
});
