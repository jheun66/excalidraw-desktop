const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  session,
  shell,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { fileURLToPath } = require("node:url");
const { randomUUID } = require("node:crypto");

const isDev = !app.isPackaged;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:5178";
const APP_FILE = path.join(__dirname, "..", "dist", "index.html");
const STATE_FILE = path.join(app.getPath("userData"), "state.json");
const LIBRARY_FILE = path.join(app.getPath("userData"), "library.json");
const LIBRARY_ORIGIN =
  process.env.EXD_LIBRARY_ORIGIN || "https://libraries.excalidraw.com";
/** Deliberately unresolvable: the redirect carrying `addLibrary=` is cancelled,
 *  never loaded, and this keeps file:// out of the referrer. */
const LIBRARY_RETURN_URL = "https://excalidraw-desktop.invalid/library-return";
const DEBUG = isDev || process.env.EXD_DEBUG === "1";

/** @type {BrowserWindow | null} */
let win = null;
let queued = [];
let rendererReady = false;
/** Last count the renderer reported; it lags an edit, so see askDirtyCount. */
let dirtyCount = 0;
/** "idle" → "asking" → "saving" (renderer writing) → "closing" (let it go). */
let closeState = "idle";
/** Set by before-quit, so a save can let the interrupted quit finish. */
let quitting = false;

app.on("before-quit", () => {
  quitting = true;
});

const EMPTY_SCENE = JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    source: "excalidraw-desktop",
    elements: [],
    appState: { viewBackgroundColor: "#ffffff", gridSize: null },
    files: {},
  },
  null,
  2,
);

/* ---- Trust boundary ---- */

/**
 * True only for this app's own document. `window.api` can read and write any
 * file the user can, so nothing else may ever reach it.
 */
function isAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (isDev) {
      return url.origin === new URL(DEV_URL).origin;
    }
    // As paths: percent-encoding differences would break a string compare.
    return url.protocol === "file:" && fileURLToPath(url) === APP_FILE;
  } catch {
    return false;
  }
}

/** Anything else — `file:`, custom schemes — can launch programs. */
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function openExternalSafe(rawUrl) {
  try {
    if (!EXTERNAL_PROTOCOLS.has(new URL(rawUrl).protocol)) {
      return false;
    }
  } catch {
    return false;
  }
  void shell.openExternal(rawUrl);
  return true;
}

function fromApp(event) {
  const frame = event.senderFrame;
  return !!frame && !frame.parent && isAppUrl(frame.url);
}

/** Every channel goes through this; a bare ipcMain.handle skips the check. */
function handleIpc(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) {
      throw new Error(`blocked IPC "${channel}" from ${event.senderFrame?.url}`);
    }
    return handler(event, ...args);
  });
}

function onIpc(channel, listener) {
  ipcMain.on(channel, (event, ...args) => {
    if (fromApp(event)) {
      listener(event, ...args);
    }
  });
}

/* ---- Writing files ---- */

const writeQueues = new Map();

/*
 * One write at a time per path, in the order asked for. Saves overlap easily —
 * ⌘S during a slow export, Save All on top of a manual save — and two writers
 * on one path interleave their bytes, with the loser's rename landing on top of
 * the winner's file.
 */
function queueWrite(filePath, task) {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(task);
  const settled = result.catch(() => {}); // a failure must not poison the chain
  writeQueues.set(filePath, settled);
  void settled.then(() => {
    if (writeQueues.get(filePath) === settled) {
      writeQueues.delete(filePath);
    }
  });
  return result;
}

/** macOS disks are case-insensitive: Flow.excalidraw and flow.excalidraw are one file. */
function samePath(a, b) {
  return a === b || (isMac && a.toLowerCase() === b.toLowerCase());
}

async function writeAtomic(filePath, data, encoding) {
  const tmp = `${filePath}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(tmp, data, encoding);
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/* ---- OS file-open plumbing ---- */

const isOpenable = (p) =>
  /\.(excalidraw|excalidraw\.json|excalidraw\.png|excalidraw\.svg|json|png|svg)$/i.test(p);

function deliver(filePath) {
  if (!filePath) {
    return;
  }
  if (win && rendererReady) {
    win.webContents.send("open-path", filePath);
    if (win.isMinimized()) {
      win.restore();
    }
    win.focus();
  } else {
    queued.push(filePath);
  }
}

function drainQueue() {
  const paths = queued;
  queued = [];
  for (const p of paths) {
    win.webContents.send("open-path", p);
  }
}

// At module load: on macOS this can fire before `ready`.
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  deliver(filePath);
});

// A second launch hands its paths over rather than opening another window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    for (const p of argv.filter(isOpenable)) {
      deliver(p);
    }
    if (win) {
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
    }
  });
}

/* ---- Window ---- */

const isMac = process.platform === "darwin";

function createWindow() {
  // A Dock reopen starts over; a leftover "closing" would skip the prompt.
  closeState = "idle";
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: "hiddenInset",
    // A transparent ground is what lets the AppKit material show through the
    // sidebar; elsewhere the window paints its own and the CSS tint sits on it.
    vibrancy: isMac ? "sidebar" : undefined,
    visualEffectState: isMac ? "active" : undefined,
    backgroundColor: isMac ? "#00000000" : "#f5f5f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(APP_FILE);
  }

  /*
   * The preload runs on whatever document this window holds, so a page it
   * navigates to would inherit `window.api`. Nothing legitimate navigates it
   * after the initial load — links go through onLinkOpen / the window-open
   * handler, and a navigation would drop every unsaved drawing anyway — so
   * refuse them all. (loadURL/loadFile themselves do not emit will-navigate.)
   */
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`[exd] blocked navigation to ${url}`);
    }
  });
  win.webContents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.log(`[exd] blocked redirect to ${url}`);
      }
    }
  });

  win.on("closed", () => {
    win = null;
    rendererReady = false;
    // The close handler cancelled the quit to ask; let it finish now.
    if (quitting) {
      app.quit();
    }
  });

  // A dead or reloaded renderer cannot answer "save-all:request".
  const resetRendererState = () => {
    dirtyCount = 0;
    closeState = "idle";
    if (win && !win.isDestroyed()) {
      win.setDocumentEdited(false);
    }
  };
  win.webContents.on("dom-ready", resetRendererState);
  win.webContents.on("render-process-gone", resetRendererState);

  // Fires when the renderer's beforeunload cancels a reload. Here
  // preventDefault() means "go ahead and unload".
  win.webContents.on("will-prevent-unload", (event) => {
    if (closeState === "closing") {
      event.preventDefault(); // the close prompt already asked
      return;
    }
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Reload and Discard", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Reloading will discard unsaved changes.",
      detail: "Save them with ⌘S first if you want to keep them.",
    });
    if (choice === 0) {
      event.preventDefault();
    }
  });

  win.on("close", (event) => {
    if (closeState === "closing") {
      return;
    }
    event.preventDefault();
    if (closeState !== "idle") {
      return; // a decision is already in flight
    }
    closeState = "asking";
    // Asked for, not read off dirtyCount: a stroke then ⌘Q would look clean.
    void askDirtyCount().then((count) => {
      if (!win || win.isDestroyed() || closeState !== "asking") {
        return;
      }
      if (count === 0) {
        closeState = "closing";
        win.close();
        return;
      }
      const choice = dialog.showMessageBoxSync(win, {
        type: "warning",
        buttons: ["Save and Close", "Close Without Saving", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        message:
          count === 1
            ? "1 drawing has unsaved changes."
            : `${count} drawings have unsaved changes.`,
        detail: "Do you want to save before closing?",
      });
      if (choice === 2) {
        closeState = "idle";
        quitting = false; // the cancelled quit must not resume later
        return;
      }
      if (choice === 1) {
        closeState = "closing";
        win.close();
        return;
      }
      closeState = "saving"; // the renderer calls back on "save-all:done"
      win.webContents.send("save-all:request");
    });
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Installing works by a redirect back to the referrer, which reaches us
    // only while the site is open in-app.
    if (isLibraryUrl(url)) {
      openLibraryBrowser(url);
      return { action: "deny" };
    }
    openExternalSafe(url);
    return { action: "deny" };
  });
}

/* ---- Library browser ---- */

/** @type {BrowserWindow | null} */
let libraryWin = null;

/** Exact origin: a prefix check also accepts `libraries.excalidraw.com.evil`. */
function isLibraryUrl(rawUrl) {
  try {
    return new URL(rawUrl).origin === new URL(LIBRARY_ORIGIN).origin;
  } catch {
    return false;
  }
}

function parseLibraryReturn(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const params = new URLSearchParams(
      (url.hash.startsWith("#") ? url.hash.slice(1) : url.hash) || url.search,
    );
    const libraryUrl = params.get("addLibrary");
    return libraryUrl ? { libraryUrl, token: params.get("token") } : null;
  } catch {
    return null;
  }
}

/**
 * Where a `.excalidrawlib` may be fetched from. The URL comes out of a page in
 * the library window, which is free to browse anywhere, and the fetch happens
 * in the main process — so an arbitrary URL would let a page read local files
 * or reach services on the user's own network through us.
 */
function isInstallableLibraryUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    // The library origin itself allows a local stub (EXD_LIBRARY_ORIGIN).
    return url.protocol === "https:" || url.origin === new URL(LIBRARY_ORIGIN).origin;
  } catch {
    return false;
  }
}

async function installLibrary(libraryUrl) {
  if (!win) {
    return;
  }
  if (!isInstallableLibraryUrl(libraryUrl)) {
    dialog.showMessageBox(win, {
      type: "error",
      message: "Couldn't add the library",
      detail: `Libraries can only be installed over https.\n${libraryUrl}`,
    });
    return;
  }
  try {
    // In the main process, so the page CSP need not allow the library host.
    const res = await fetch(libraryUrl);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const text = await res.text();
    win.webContents.send("library:add", { url: libraryUrl, text });
    win.focus();
  } catch (err) {
    dialog.showMessageBox(win, {
      type: "error",
      message: "Couldn't download the library",
      detail: `${libraryUrl}\n${String(err.message || err)}`,
    });
  }
}

function openLibraryBrowser(url) {
  if (libraryWin && !libraryWin.isDestroyed()) {
    libraryWin.focus();
    libraryWin.loadURL(url);
    return;
  }
  libraryWin = new BrowserWindow({
    width: 1100,
    height: 800,
    parent: win ?? undefined,
    title: "Excalidraw Libraries",
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      // Its own session: this app's CSP would leave a normal site half-broken.
      // Persistent, so a sign-in survives.
      partition: "persist:library",
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  libraryWin.setMenuBarVisibility(false);

  const libSession = libraryWin.webContents.session;
  if (!libSession.__exdConfigured) {
    libSession.__exdConfigured = true;
    libSession.on("will-download", (_e, item) => {
      item.setSaveDialogOptions({ title: "Save", defaultPath: item.getFilename() });
    });
  }
  // Sites sniff the Electron tokens and serve a degraded page.
  const appToken = app.name.replace(/\s/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  libraryWin.webContents.setUserAgent(
    libraryWin.webContents
      .getUserAgent()
      .replace(new RegExp(`\\s*(${appToken}|Electron)/\\S+`, "g"), ""),
  );

  const intercept = (event, nextUrl) => {
    const found = parseLibraryReturn(nextUrl);
    if (!found) {
      return;
    }
    event.preventDefault();
    void installLibrary(found.libraryUrl);
    if (libraryWin && !libraryWin.isDestroyed()) {
      libraryWin.close();
    }
  };
  libraryWin.webContents.on("will-navigate", intercept);
  libraryWin.webContents.on("will-redirect", intercept);
  libraryWin.webContents.setWindowOpenHandler(({ url: popup }) => {
    const found = parseLibraryReturn(popup);
    if (found) {
      void installLibrary(found.libraryUrl);
    } else {
      openExternalSafe(popup);
    }
    return { action: "deny" };
  });
  libraryWin.on("closed", () => {
    libraryWin = null;
  });
  libraryWin.loadURL(url);
}

handleIpc("library:get", async () => {
  try {
    return JSON.parse(await fs.readFile(LIBRARY_FILE, "utf8"));
  } catch {
    return [];
  }
});

handleIpc("library:set", async (_e, items) => {
  try {
    await queueWrite(LIBRARY_FILE, () =>
      writeAtomic(LIBRARY_FILE, JSON.stringify(items), "utf8"),
    );
  } catch {
    /* best effort */
  }
});

handleIpc("library:returnUrl", () => LIBRARY_RETURN_URL);

onIpc("renderer:ready", () => {
  rendererReady = true;
  drainQueue();
});

/** A live count, falling back to the last reported one. See `dirtyCount`. */
let dirtyQueryId = 0;
const dirtyQueries = new Map();

function askDirtyCount(timeoutMs = 1500) {
  if (!win || !rendererReady || win.webContents.isCrashed()) {
    return Promise.resolve(dirtyCount);
  }
  const id = ++dirtyQueryId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      dirtyQueries.delete(id);
      resolve(dirtyCount);
    }, timeoutMs);
    dirtyQueries.set(id, (count) => {
      clearTimeout(timer);
      resolve(count);
    });
    win.webContents.send("dirty:query", id);
  });
}

onIpc("dirty:reply", (_e, id, count) => {
  const resolve = dirtyQueries.get(id);
  if (resolve) {
    dirtyQueries.delete(id);
    resolve(Number(count) || 0);
  }
});

onIpc("dirty:count", (_e, count) => {
  dirtyCount = count;
  if (win) {
    win.setDocumentEdited(count > 0);
  }
});

onIpc("save-all:done", (_e, ok) => {
  if (closeState !== "saving") {
    return;
  }
  if (ok !== true) {
    // Reported by the renderer already. Keep the window, and ask again later.
    closeState = "idle";
    quitting = false;
    return;
  }
  closeState = "closing";
  if (win) {
    win.close();
  }
});

onIpc("debug:log", (_e, line) => {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log(line);
  }
});

handleIpc("app:flags", () => ({
  debug: DEBUG,
  // Elsewhere the renderer paints its own ground behind the sidebar.
  vibrancy: process.platform === "darwin",
}));

handleIpc("link:open", (_e, url) => openExternalSafe(String(url)));

/* ---- Menu ---- */

function send(command) {
  if (win) {
    win.webContents.send("menu", command);
  }
}

/** Read off disk: the menu is built before the renderer exists. */
let glassLevel = (() => {
  try {
    const saved = JSON.parse(
      require("node:fs").readFileSync(STATE_FILE, "utf8"),
    ).glass;
    return ["clear", "default", "frosted"].includes(saved) ? saved : "default";
  } catch {
    return "default";
  }
})();

let lastState = { openPaths: [], activePath: null, sidebarCollapsed: false };

function setGlass(level) {
  glassLevel = level;
  send(`glass:${level}`);
  void persistState(lastState);
}

function buildMenu() {
  const template = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" }]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New Drawing…", accelerator: "CmdOrCtrl+N", click: () => send("new") },
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => send("open") },
        { type: "separator" },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: () => send("save") },
        {
          label: "Save All",
          accelerator: "CmdOrCtrl+Alt+S",
          click: () => send("save-all"),
        },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => send("close") },
        { type: "separator" },
        { label: "Rename…", click: () => send("rename") },
        { label: "Move to Trash", click: () => send("trash") },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Show/Hide Sidebar",
          accelerator: "CmdOrCtrl+B",
          click: () => send("toggle-sidebar"),
        },
        {
          label: "Sidebar Transparency",
          submenu: [
            {
              label: "High",
              type: "radio",
              checked: glassLevel === "clear",
              click: () => setGlass("clear"),
            },
            {
              label: "Medium",
              type: "radio",
              checked: glassLevel === "default",
              click: () => setGlass("default"),
            },
            {
              label: "Low",
              type: "radio",
              checked: glassLevel === "frosted",
              click: () => setGlass("frosted"),
            },
          ],
        },
        // No ⌘R in a built app: unsaved drawings live only in the renderer.
        // DevTools loses nothing, so it follows the debug flag.
        ...(isDev ? [{ type: "separator" }, { role: "reload" }, { role: "forceReload" }] : []),
        ...(DEBUG ? [{ role: "toggleDevTools" }] : []),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---- IPC: files ---- */

handleIpc("dialog:open", async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Excalidraw",
        extensions: ["excalidraw", "json", "png", "svg"],
      },
    ],
  });
  return res.canceled ? [] : res.filePaths;
});

handleIpc("dialog:new", async (_e, openPaths = []) => {
  const res = await dialog.showSaveDialog(win, {
    title: "New Drawing",
    defaultPath: "untitled.excalidraw",
    filters: [{ name: "Excalidraw", extensions: ["excalidraw"] }],
  });
  if (res.canceled || !res.filePath) {
    return null;
  }
  // The dialog asks before replacing the name the user typed — but if the
  // extension had to be added, it warned about a different file.
  const added = !res.filePath.endsWith(".excalidraw");
  const filePath = added ? `${res.filePath}.excalidraw` : res.filePath;
  const name = path.basename(filePath);
  // Emptying an open drawing would leave its tab showing a scene that is no
  // longer on disk, marked saved.
  if ((openPaths ?? []).some((p) => samePath(String(p), filePath))) {
    return {
      error: `"${name}" is already open. Close its tab first, or pick another name.`,
    };
  }
  try {
    await fs.writeFile(
      filePath,
      EMPTY_SCENE,
      added ? { encoding: "utf8", flag: "wx" } : "utf8",
    );
  } catch (err) {
    if (err.code === "EEXIST") {
      return { error: `"${name}" already exists.` };
    }
    return { error: String(err.message || err) };
  }
  return { path: filePath };
});

handleIpc("file:read", async (_e, filePath) => {
  const base = {
    path: filePath,
    fileName: path.basename(filePath),
    name: path
      .basename(filePath)
      .replace(/\.excalidraw\.(json|png|svg)$/i, "")
      .replace(/\.excalidraw$/i, "")
      .replace(/\.(json|png|svg)$/i, ""),
    dir: path.dirname(filePath).replace(app.getPath("home"), "~"),
  };
  try {
    const content = await fs.readFile(filePath, "utf8");
    return { ...base, content };
  } catch (err) {
    return { ...base, content: null, error: String(err.message || err) };
  }
});

handleIpc("file:readBase64", async (_e, filePath) => {
  try {
    const buf = await fs.readFile(filePath);
    return { base64: buf.toString("base64") };
  } catch (err) {
    return { base64: null, error: String(err.message || err) };
  }
});

handleIpc("file:writeBase64", async (_e, filePath, base64) => {
  try {
    await queueWrite(filePath, () =>
      writeAtomic(filePath, Buffer.from(base64, "base64")),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

handleIpc("file:write", async (_e, filePath, content) => {
  try {
    await queueWrite(filePath, () => writeAtomic(filePath, content, "utf8"));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

handleIpc("file:reveal", async (_e, filePath) => {
  shell.showItemInFolder(filePath);
});

/** Splits `flow.excalidraw.png` into ["flow", ".excalidraw.png"]. */
function splitName(fileName) {
  const m = fileName.match(/^(.*?)((?:\.excalidraw)?\.(?:json|png|svg)|\.excalidraw)$/i);
  return m ? [m[1], m[2]] : [fileName, ""];
}

handleIpc("file:rename", async (_e, filePath, nextBase) => {
  const dir = path.dirname(filePath);
  const [, ext] = splitName(path.basename(filePath));
  const clean = String(nextBase).trim().replace(/[/\\]/g, "-");
  if (!clean) {
    return { ok: false, error: "The name can't be empty." };
  }
  const nextPath = path.join(dir, clean + ext);
  if (nextPath === filePath) {
    return { ok: true, path: filePath };
  }
  // Flow → flow is the same file on a case-insensitive disk; the check below
  // would refuse it as "already exists".
  if (!samePath(nextPath, filePath)) {
    try {
      await fs.access(nextPath);
      return { ok: false, error: `"${clean + ext}" already exists.` };
    } catch {
      /* free */
    }
  }
  try {
    await fs.rename(filePath, nextPath);
    return { ok: true, path: nextPath };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

handleIpc("file:trash", async (_e, filePath) => {
  try {
    await shell.trashItem(filePath); // never unlink: a mis-click must be undoable
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

handleIpc("dialog:confirmTrash", async (_e, name) => {
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Move to Trash", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `Move "${name}" to the Trash?`,
    detail: "You can restore it from the Trash in Finder.",
  });
  return response === 0;
});

handleIpc("menu:tab", async () => {
  return new Promise((resolve) => {
    let done = false;
    const pick = (action) => () => {
      done = true;
      resolve(action);
    };
    const menu = Menu.buildFromTemplate([
      { label: "Rename…", click: pick("rename") },
      { label: "Show in Finder", click: pick("reveal") },
      { type: "separator" },
      { label: "Move to Trash", click: pick("trash") },
    ]);
    menu.popup({
      window: win ?? undefined,
      callback: () => {
        if (!done) { // fires after close: nothing picked means dismissed
          resolve(null);
        }
      },
    });
  });
});

handleIpc("dialog:confirmDiscard", async (_e, name) => {
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Save", "Don't Save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    message: `"${name}" has unsaved changes.`,
    detail: "Do you want to save before closing?",
  });
  return ["save", "discard", "cancel"][response];
});

handleIpc("dialog:error", async (_e, message, title) => {
  dialog.showMessageBox(win, {
    type: "error",
    message: title || "Something went wrong",
    detail: message,
  });
});

/* ---- IPC: session state ---- */

handleIpc("store:get", async () => {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const openPaths = []; // files moved or deleted since are dropped
    for (const p of parsed.openPaths || []) {
      try {
        await fs.access(p);
        openPaths.push(p);
      } catch {
        /* gone — skip */
      }
    }
    return {
      openPaths,
      activePath: openPaths.includes(parsed.activePath)
        ? parsed.activePath
        : null,
      sidebarCollapsed: !!parsed.sidebarCollapsed,
      glass: glassLevel,
    };
  } catch {
    return {
      openPaths: [],
      activePath: null,
      sidebarCollapsed: false,
      glass: glassLevel,
    };
  }
});

async function persistState(value) {
  try {
    // A truncated state file would silently drop the whole restore list.
    await queueWrite(STATE_FILE, () =>
      writeAtomic(
        STATE_FILE,
        JSON.stringify({ ...value, glass: glassLevel }, null, 2),
        "utf8",
      ),
    );
  } catch {
    /* best effort */
  }
}

handleIpc("store:set", async (_e, value) => {
  lastState = value;
  await persistState(value);
});

/* ---- Lifecycle ---- */

app.whenReady().then(() => {
  // From source there is no bundle, so the Dock would show Electron's icon.
  if (isDev && isMac) {
    try {
      const iconPath = path.join(__dirname, "..", "build", "icon.png");
      if (require("node:fs").existsSync(iconPath)) {
        app.dock.setIcon(iconPath);
      }
    } catch {
      /* cosmetic only */
    }
  }

  const csp = isDev
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5178; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://localhost:5178 http://localhost:5178 data: blob:"
    : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:";

  // Without the File System Access API (see src/fsa-shim.ts) "Save to…" falls
  // back to a download, which would land in Downloads unannounced.
  session.defaultSession.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({
      title: "Save",
      defaultPath: item.getFilename(),
    });
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Own documents only: this policy assumes a self-contained bundle and would
    // leave the library site half-broken.
    const ours =
      details.url.startsWith(DEV_URL) || details.url.startsWith("file://");
    if (!ours) {
      callback({});
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });

  for (const arg of process.argv.slice(1)) {
    if (isOpenable(arg)) {
      queued.push(arg);
    }
  }

  buildMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
