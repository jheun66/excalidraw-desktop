/*
 * Shared scaffolding for the end-to-end tests.
 *
 * Each test boots the real electron/main.cjs against the built dist/, with the
 * Electron modules it requires swapped for stubs: the app reports itself as
 * packaged, native dialogs answer from the test, and file writes can be slowed
 * down. Everything a test writes lives under test/.work/<name>/.
 */
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");
const electron = require("electron");

const { app, BrowserWindow, dialog } = electron;

const ROOT = path.resolve(__dirname, "..");
const MAIN = path.join(ROOT, "electron");
const FIXTURES = path.join(__dirname, "fixtures");

/* ---- results ---- */

let failures = 0;

function check(name, ok, detail) {
  if (!ok) {
    failures++;
  }
  const extra = detail === undefined ? "" : `  — ${JSON.stringify(detail)}`;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra}`);
}

function report() {
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  app.exit(failures ? 1 : 0);
}

function fail(err) {
  failures++;
  console.log("ERROR", err?.stack ?? String(err));
}

/* ---- waiting ---- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch {
      /* not ready yet */
    }
    await sleep(100);
  }
  return null;
}

/* ---- scene fixtures ---- */

let seed = 0;

/** An element with everything Excalidraw's restore expects. */
function element(id, overrides = {}) {
  seed++;
  return {
    id,
    type: "rectangle",
    x: 0, y: 0, width: 400, height: 300, angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "#a5d8ff",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    ...overrides,
  };
}

const scene = (elements, files = {}) =>
  JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "test",
    elements,
    appState: { viewBackgroundColor: "#ffffff" },
    files,
  });

/** Live element count of a drawing on disk. Throws if it is not valid JSON. */
const countIn = (file) =>
  JSON.parse(fs.readFileSync(file, "utf8")).elements.filter((e) => !e.isDeleted)
    .length;

/* ---- workspace ---- */

/** A clean directory for one test run, plus the app's userData inside it. */
function workspace(name) {
  const dir = path.join(__dirname, ".work", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "userData"), { recursive: true });
  return {
    dir,
    userData: path.join(dir, "userData"),
    file: (fileName) => path.join(dir, fileName),
    /** Writes a drawing and returns its path. */
    drawing(fileName, elements, files) {
      const file = path.join(dir, fileName);
      fs.writeFileSync(file, scene(elements, files));
      return file;
    },
    write(fileName, contents) {
      const file = path.join(dir, fileName);
      fs.writeFileSync(file, contents);
      return file;
    },
    fixture(fileName) {
      const file = path.join(dir, fileName);
      fs.copyFileSync(path.join(FIXTURES, fileName), file);
      return file;
    },
    /** What the app restores on launch. */
    session({ open = [], active = open[0], sidebarCollapsed = false } = {}) {
      fs.writeFileSync(
        path.join(dir, "userData", "state.json"),
        JSON.stringify({ openPaths: open, activePath: active, sidebarCollapsed }),
      );
    },
    state() {
      return JSON.parse(
        fs.readFileSync(path.join(dir, "userData", "state.json"), "utf8"),
      );
    },
    /** Temp files the app failed to clean up. */
    strayTemps() {
      return [
        ...fs.readdirSync(dir),
        ...fs.readdirSync(path.join(dir, "userData")),
      ].filter((n) => n.includes(".tmp"));
    },
  };
}

/* ---- stubs ---- */

const dialogs = [];
let answerDialog = () => null;

/** Answers native message boxes; return a button index, or null for Cancel. */
function onDialog(fn) {
  answerDialog = fn;
}

const bind = (target, overrides) =>
  new Proxy(target, {
    get(t, prop) {
      if (prop in overrides) {
        return overrides[prop];
      }
      const value = Reflect.get(t, prop);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });

/**
 * Swaps what electron/main.cjs requires. Call before `start()`.
 *
 * `dev: true` leaves the app unpackaged (dev menu, dev URL). `saveDialog`
 * returns the path the "New Drawing" dialog should hand back. `slowWrite`
 * pauses halfway through matching writes, which is where overlapping saves
 * collide; `slowRead` delays reads of files whose name contains "slow", which
 * keeps the session restore running while other things happen. `shell`
 * overrides land on Electron's shell module.
 */
function stub({ dev = false, saveDialog = null, slowWrite = null, slowRead = false, shell: shellOverrides = null } = {}) {
  const respond = (a, b) => {
    const options = b ?? a;
    dialogs.push(`${options.message} ${options.detail ?? ""}`.trim());
    return answerDialog(options) ?? options.cancelId ?? 0;
  };

  const appStub = dev ? app : bind(app, { isPackaged: true });
  const dialogStub = bind(dialog, {
    showMessageBox: async (a, b) => ({ response: respond(a, b) }),
    showMessageBoxSync: (a, b) => respond(a, b),
    ...(saveDialog
      ? {
          showSaveDialog: async () => {
            const filePath = saveDialog();
            return filePath ? { canceled: false, filePath } : { canceled: true };
          },
        }
      : {}),
  });
  const shellStub = shellOverrides ? bind(electron.shell, shellOverrides) : null;

  const realFsp = require("node:fs/promises");
  const fspStub = slowWrite || slowRead
    ? bind(realFsp, {
        readFile: async (file, encoding) => {
          if (slowRead && String(file).includes("slow")) {
            await sleep(900);
          }
          return realFsp.readFile(file, encoding);
        },
        writeFile: async (file, data, encoding) => {
          if (!slowWrite) {
            return realFsp.writeFile(file, data, encoding);
          }
          const pause = slowWrite(String(file));
          if (!pause) {
            return realFsp.writeFile(file, data, encoding);
          }
          // Truncate, write half, pause, write the rest: the window in which a
          // second writer can land on the same file.
          const buf = Buffer.isBuffer(data)
            ? data
            : Buffer.from(String(data), encoding || "utf8");
          const handle = await realFsp.open(file, "w");
          try {
            const half = Math.floor(buf.length / 2);
            await handle.write(buf.subarray(0, half), 0, half, 0);
            await sleep(pause);
            await handle.write(buf.subarray(half), 0, buf.length - half, half);
          } finally {
            await handle.close();
          }
        },
      })
    : null;

  const realLoad = Module._load;
  Module._load = function (request, parent) {
    const mod = realLoad.apply(this, arguments);
    if (!parent?.filename?.startsWith(MAIN)) {
      return mod;
    }
    if (fspStub && request === "node:fs/promises") {
      return fspStub;
    }
    if (request === "electron") {
      return new Proxy(mod, {
        get(t, prop) {
          if (prop === "app") return appStub;
          if (prop === "dialog") return dialogStub;
          if (prop === "shell" && shellStub) return shellStub;
          return Reflect.get(t, prop);
        },
      });
    }
    return mod;
  };
}

/* ---- boot ---- */

/**
 * Loads the app the way a packaged launch would, and hands back the window
 * once its canvas is up. `argv` adds paths the OS would pass on launch.
 */
async function start(ws, { argv = [], waitForCanvas = true } = {}) {
  app.setName("Excalidraw Desktop");
  app.setPath("userData", ws.userData);
  for (const arg of argv) {
    process.argv.push(arg);
  }
  require(path.join(MAIN, "main.cjs"));

  await app.whenReady();
  await sleep(0); // let main.cjs's own whenReady handler create the window
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  if (wc.isLoading()) {
    await new Promise((resolve) => wc.once("did-finish-load", resolve));
  }
  win.focus();
  wc.focus();
  const view = ui(win);
  if (waitForCanvas) {
    await view.ready();
  }
  return view;
}

/* ---- driving the window ---- */

/** Everything the tests do to a window, so no test pokes at the DOM directly. */
function ui(win) {
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(code, true);
  const tabSelector = (label) =>
    `[...document.querySelectorAll('.exd-tab')].find(t => t.querySelector('.exd-tab-name')?.firstChild?.textContent === ${JSON.stringify(label)})`;

  const view = {
    win,
    wc,
    js,

    async ready() {
      await waitFor(() =>
        js("!!document.querySelector('.excalidraw canvas.interactive') || !!document.querySelector('.exd-notice')"),
      );
      await sleep(1200);
    },

    tabs: () =>
      js(`[...document.querySelectorAll('.exd-tab')].map(t => ({
        name: t.querySelector('.exd-tab-name')?.firstChild?.textContent,
        dirty: !!t.querySelector('.exd-mark-dirty'),
        broken: t.classList.contains('is-broken'),
      }))`),

    async tab(label) {
      return (await view.tabs()).find((t) => t.name === label) ?? null;
    },

    waitTabs: (count) =>
      waitFor(async () => (await view.tabs()).length === count || null),

    async select(label) {
      const found = await js(`(() => {
        const t = ${tabSelector(label)};
        if (!t) return false;
        t.querySelector('.exd-tab-main').click();
        return true;
      })()`);
      if (found) {
        await sleep(400);
        await view.ready();
      }
      return found;
    },

    /** The unsaved marker lands DIRTY_CHECK_MS after an edit, later when busy. */
    waitDirty: async (label, want = true) =>
      (await waitFor(
        async () => ((await view.tab(label))?.dirty === want ? true : null),
        5000,
      )) === true,

    notice: () => js("document.querySelector('.exd-notice-danger')?.innerText ?? null"),
    hasCanvas: () => js("!!document.querySelector('.excalidraw canvas.interactive')"),

    box: () =>
      js(`(() => { const b = document.querySelector('.exd-canvas-area').getBoundingClientRect();
        return { left: b.left, top: b.top, width: b.width, height: b.height }; })()`),

    async click(x, y, clickCount = 1) {
      wc.sendInputEvent({ type: "mouseMove", x, y });
      await sleep(40);
      wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount });
      await sleep(40);
      wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount });
      await sleep(60);
    },

    async drag(x1, y1, x2, y2, steps = 6) {
      wc.sendInputEvent({ type: "mouseMove", x: x1, y: y1 });
      await sleep(40);
      wc.sendInputEvent({ type: "mouseDown", x: x1, y: y1, button: "left", clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        await sleep(30);
        wc.sendInputEvent({
          type: "mouseMove",
          modifiers: ["leftButtonDown"],
          x: Math.round(x1 + ((x2 - x1) * i) / steps),
          y: Math.round(y1 + ((y2 - y1) * i) / steps),
        });
      }
      await sleep(40);
      wc.sendInputEvent({ type: "mouseUp", x: x2, y: y2, button: "left", clickCount: 1 });
      await sleep(60);
    },

    async key(keyCode, modifiers = []) {
      wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      await sleep(30);
      wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await sleep(200);
    },

    /**
     * Draws a rectangle on empty canvas. `offset` shifts it right; the left of
     * the canvas is where the style panel opens, so drawing happens on the
     * right. `settle` is how long to wait for the unsaved marker.
     */
    async draw({ offset = 0, settle = 800 } = {}) {
      await js(`document.querySelector('[data-testid="toolbar-rectangle"]').click(); 1`);
      await sleep(150);
      const b = await view.box();
      const x = Math.round(b.left + b.width - 350 + offset);
      const y = Math.round(b.top + b.height - 260);
      await view.drag(x, y, x + 90, y + 90);
      await sleep(settle);
    },

    /** Menu commands, as the real menu sends them. */
    async menu(command, settle = 1500) {
      wc.send("menu", command);
      await sleep(settle);
    },

    /** A path handed over by the OS (double-click, or a second launch). */
    async openPath(file, settle = 1500) {
      wc.send("open-path", file);
      await sleep(settle);
    },
  };
  return view;
}

module.exports = {
  ROOT,
  FIXTURES,
  check,
  report,
  fail,
  sleep,
  waitFor,
  element,
  scene,
  countIn,
  workspace,
  stub,
  start,
  ui,
  dialogs,
  onDialog,
  electron,
};
