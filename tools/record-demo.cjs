/*
 * Records docs/demo.gif: drawings arriving from the OS, switching between them,
 * an edit, a save. Drives the built renderer and captures the window's own
 * region of the screen, on a plain backdrop so nothing else is filmed.
 *
 *   npm run build:renderer
 *   npx electron tools/record-demo.cjs
 *
 * Needs ffmpeg, and macOS screen-recording permission for the terminal.
 */
const path = require("node:path");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { app, BrowserWindow, dialog, screen } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const WORK = path.join(__dirname, ".out", "demo");
const MOV = path.join(WORK, "demo.mov");
const GIF = path.join(ROOT, "docs", "demo.gif");

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, "userData"), { recursive: true });
app.setName("Excalidraw Desktop");
app.setPath("userData", path.join(WORK, "userData"));

/* a packaged-looking app with silent dialogs */
const Module = require("node:module");
const realLoad = Module._load;
const bind = (target, overrides) =>
  new Proxy(target, {
    get(t, p) {
      if (p in overrides) return overrides[p];
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
Module._load = function (request, parent) {
  const mod = realLoad.apply(this, arguments);
  if (request === "electron" && parent?.filename?.startsWith(path.join(ROOT, "electron"))) {
    return new Proxy(mod, {
      get(t, p) {
        if (p === "app") return bind(app, { isPackaged: true });
        if (p === "dialog") {
          return bind(dialog, {
            showMessageBox: async () => ({ response: 0 }),
            showMessageBoxSync: () => 0,
          });
        }
        return Reflect.get(t, p);
      },
    });
  }
  return mod;
};

/* drawings worth filming */
let seed = 0;
const base = () => ({
  angle: 0, strokeColor: "#1e1e1e", fillStyle: "solid", strokeWidth: 2,
  strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null,
  seed: 1000 + ++seed * 37, version: 1, versionNonce: 1000 + seed * 11,
  isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
});
const box = (x, y, w, h, backgroundColor) => ({ ...base(), id: `b${seed}`, type: "rectangle", x, y, width: w, height: h, backgroundColor, roundness: { type: 3 } });
const ellipse = (x, y, w, h, backgroundColor) => ({ ...base(), id: `e${seed}`, type: "ellipse", x, y, width: w, height: h, backgroundColor, roundness: null });
const text = (x, y, value, fontSize = 20) => ({
  ...base(), id: `t${seed}`, type: "text", x, y,
  width: value.length * fontSize * 0.55, height: fontSize * 1.25,
  backgroundColor: "transparent", roundness: null, text: value, originalText: value,
  fontSize, fontFamily: 5, textAlign: "left", verticalAlign: "top",
  containerId: null, lineHeight: 1.25,
});
const arrow = (x, y, dx, dy) => ({
  ...base(), id: `a${seed}`, type: "arrow", x, y,
  width: Math.abs(dx), height: Math.abs(dy), backgroundColor: "transparent",
  roundness: { type: 2 }, points: [[0, 0], [dx, dy]], lastCommittedPoint: null,
  startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: "arrow",
});
const write = (name, elements) => {
  const file = path.join(WORK, `${name}.excalidraw`);
  fs.writeFileSync(file, JSON.stringify({
    type: "excalidraw", version: 2, source: "demo", elements,
    appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: {},
  }, null, 2));
  return file;
};

const drawings = {
  "Sign-up flow": write("Sign-up flow", [
    box(60, 80, 220, 90, "#a5d8ff"), text(96, 112, "Landing page"),
    arrow(170, 180, 0, 70),
    box(60, 260, 220, 90, "#b2f2bb"), text(112, 292, "Sign up"),
    arrow(290, 305, 130, 0),
    box(430, 260, 220, 90, "#ffd8a8"), text(470, 292, "Verify email"),
    arrow(540, 360, 0, 70),
    box(430, 440, 220, 90, "#d0bfff"), text(492, 472, "Welcome"),
  ]),
  "App wireframe": write("App wireframe", [
    box(60, 60, 620, 420, "#f8f9fa"),
    box(80, 80, 140, 380, "#dee2e6"), text(104, 100, "Sidebar", 16),
    box(240, 80, 420, 60, "#a5d8ff"), text(268, 98, "Header", 16),
    box(240, 160, 200, 140, "#ffec99"),
    box(460, 160, 200, 140, "#b2f2bb"),
    box(240, 320, 420, 140, "#ffd8a8"), text(268, 340, "Content", 16),
  ]),
  "Retro notes": write("Retro notes", [
    ellipse(260, 200, 220, 120, "#ffc9c9"), text(310, 245, "Sprint 24"),
    arrow(270, 230, -140, -80),
    box(40, 100, 180, 70, "#b2f2bb"), text(66, 122, "Went well", 16),
    arrow(480, 230, 150, -70),
    box(620, 120, 180, 70, "#ffd8a8"), text(646, 142, "To improve", 16),
    arrow(370, 330, 0, 90),
    box(280, 430, 180, 70, "#d0bfff"), text(306, 452, "Next steps", 16),
  ]),
};
fs.writeFileSync(path.join(WORK, "userData", "state.json"), JSON.stringify({
  openPaths: [drawings["Sign-up flow"]],
  activePath: drawings["Sign-up flow"],
  sidebarCollapsed: false,
}));

require(path.join(ROOT, "electron", "main.cjs"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeout = 20000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return true;
    } catch {}
    await sleep(100);
  }
  return false;
};

app.whenReady().then(async () => {
  let recorder = null;
  let failed = false;
  try {
    await sleep(0);
    const win = BrowserWindow.getAllWindows()[0];
    const wc = win.webContents;
    if (wc.isLoading()) await new Promise((r) => wc.once("did-finish-load", r));
    const js = (code) => wc.executeJavaScript(code, true);

    // A plain backdrop: the sidebar is translucent, so whatever is on screen
    // would otherwise show through it.
    const display = screen.getPrimaryDisplay().bounds;
    const backdrop = new BrowserWindow({
      x: display.x, y: display.y, width: display.width, height: display.height,
      frame: false, hasShadow: false, focusable: false, skipTaskbar: true,
      backgroundColor: "#e9ecf2",
    });
    await backdrop.loadURL(
      "data:text/html," +
        encodeURIComponent(`<body style="margin:0;height:100vh;background:linear-gradient(140deg,#eef1f6,#d7dde8 60%,#cdd5e3)"></body>`),
    );
    backdrop.showInactive();

    const area = screen.getPrimaryDisplay().workArea;
    const W = 1180;
    const H = 760;
    const x = Math.round(area.x + (area.width - W) / 2);
    const y = Math.round(area.y + Math.min(80, (area.height - H) / 2));
    win.setBounds({ x, y, width: W, height: H });
    win.show();
    win.focus();
    wc.focus();
    await waitFor(() => js("!!document.querySelector('.excalidraw canvas.interactive')"));
    await sleep(1500);

    const pad = 24; // the shadow falls outside the window's own bounds
    recorder = spawn("screencapture", ["-v", "-R", [x - pad, y - pad, W + pad * 2, H + pad * 2].join(","), MOV], { stdio: "ignore" });
    await sleep(1200);

    const openFile = async (name, hold = 2200) => {
      wc.send("open-path", drawings[name]);
      await sleep(hold);
    };
    const clickTab = async (label, hold = 1800) => {
      await js(`(() => {
        const t = [...document.querySelectorAll('.exd-tab')].find(t => t.querySelector('.exd-tab-name')?.firstChild?.textContent === ${JSON.stringify(label)});
        t?.querySelector('.exd-tab-main').click();
        return 1;
      })()`);
      await sleep(hold);
    };

    /* a second and third drawing arrive, as if double-clicked in Finder */
    await openFile("App wireframe");
    await openFile("Retro notes");

    /* flip between them */
    await clickTab("Sign-up flow");
    await clickTab("App wireframe");
    await clickTab("Retro notes", 1200);

    /* draw something: the unsaved dot appears */
    await js(`document.querySelector('[data-testid="toolbar-rectangle"]').click(); 1`);
    await sleep(400);
    const b = await js(`(() => { const r = document.querySelector('.exd-canvas-area').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
    const sx = Math.round(b.l + b.w - 380);
    const sy = Math.round(b.t + b.h - 300);
    wc.sendInputEvent({ type: "mouseMove", x: sx, y: sy });
    wc.sendInputEvent({ type: "mouseDown", x: sx, y: sy, button: "left", clickCount: 1 });
    for (let i = 1; i <= 14; i++) {
      await sleep(28);
      wc.sendInputEvent({ type: "mouseMove", modifiers: ["leftButtonDown"], x: sx + i * 16, y: sy + i * 11 });
    }
    wc.sendInputEvent({ type: "mouseUp", x: sx + 224, y: sy + 154, button: "left", clickCount: 1 });
    await waitFor(() => js("!!document.querySelector('.exd-mark-dirty')"), 4000);
    await sleep(1400);

    /* ⌘S: the dot clears */
    wc.send("menu", "save");
    await waitFor(() => js("!document.querySelector('.exd-mark-dirty')"), 6000);
    await sleep(900);
    // Click empty canvas, so the clip ends on the drawing rather than on the
    // style panel a selection opens.
    const ex = Math.round(b.l + b.w - 120);
    const ey = Math.round(b.t + 170);
    wc.sendInputEvent({ type: "mouseMove", x: ex, y: ey });
    await sleep(120);
    wc.sendInputEvent({ type: "mouseDown", x: ex, y: ey, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: ex, y: ey, button: "left", clickCount: 1 });
    await sleep(2000);
  } catch (err) {
    failed = true;
    console.log("ERROR", err?.message ?? String(err));
  }
  if (recorder) {
    recorder.kill("SIGINT");
    await sleep(2500);
  }
  if (!failed && fs.existsSync(MOV)) {
    const convert = spawnSync("ffmpeg", [
      "-y", "-i", MOV,
      "-vf", "fps=12,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3",
      GIF,
    ], { encoding: "utf8" });
    if (convert.status === 0) {
      console.log(`wrote docs/demo.gif (${Math.round(fs.statSync(GIF).size / 1024)} KB)`);
    } else {
      failed = true;
      console.log("ffmpeg failed:", convert.stderr?.split("\n").slice(-3).join(" "));
    }
  } else if (!failed) {
    failed = true;
    console.log("no recording — is screen recording allowed for this terminal?");
  }
  app.exit(failed ? 1 : 0);
});
