/*
 * The preload gives the window `window.api`, which reads and writes any file
 * the user can. Nothing but the app's own page may reach it: the window never
 * navigates, links leave through the OS only for http(s)/mailto, and every IPC
 * channel checks its sender.
 */
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  check, report, fail, sleep, waitFor, element, ROOT,
  workspace, stub, start, onDialog, electron,
} = require("./support.cjs");

const { BrowserWindow } = electron;
const LIBRARY_ORIGIN = "http://libs.localhost"; // no such host: nothing loads
process.env.EXD_LIBRARY_ORIGIN = LIBRARY_ORIGIN;

const ws = workspace("security");
const evil = ws.write("evil.html", "<!doctype html><p>not the app</p>");
const evilUrl = pathToFileURL(evil).href;
const appUrl = pathToFileURL(path.join(ROOT, "dist", "index.html")).href;

const cases = [
  { name: "remote", link: "https://attacker.example/#file://" },
  { name: "local", link: "file:///System/Applications/Calculator.app" },
  { name: "element", link: `${appUrl}?element=missing-id` },
];
for (const c of cases) {
  c.file = ws.drawing(`${c.name}.excalidraw`, [element(`r-${c.name}`, { link: c.link })]);
}
ws.session({ open: cases.map((c) => c.file), active: cases[0].file });

const opened = [];
stub({ shell: { openExternal: async (url) => void opened.push(url) } });

start(ws).then(async (ui) => {
  try {
    onDialog(() => null);
    const js = ui.js;
    const url = ui.wc.getURL();
    const intact = async () => ui.wc.getURL() === url && (await js("typeof window.api")) === "object";

    check("window.api is exposed under sandbox", (await js("typeof window.api")) === "object");
    check("IPC from the app is answered", typeof (await js("window.api.getFlags()"))?.debug === "boolean");
    check("the session restored through IPC", !!(await ui.waitTabs(3)));

    /* navigation */
    await js("location.href = 'https://attacker.example/#file://'; 1");
    await sleep(800);
    check("navigation to a remote page is blocked", await intact(), ui.wc.getURL());
    await js(`(() => { const w = window.open(undefined, "_self"); if (w) { w.opener = null; w.location = "https://attacker.example/#file://"; } return 1; })()`);
    await sleep(800);
    check("Excalidraw's own _self navigation is blocked", await intact());
    await js(`location.href = ${JSON.stringify(evilUrl)}; 1`);
    await sleep(800);
    check("navigation to another file:// page is blocked", await intact());
    check("the open drawings survive the attempts", (await ui.tabs()).length === 3);

    /* clicking the links themselves */
    for (const c of cases) {
      await ui.select(c.name);
      const box = await ui.box();
      await ui.click(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2));
      const anchor = await waitFor(
        () => js(`(() => { const el = document.querySelector('.excalidraw-hyperlinkContainer-link');
          if (!el) return null; const b = el.getBoundingClientRect();
          return { x: Math.round(b.left + Math.min(20, b.width / 2)), y: Math.round(b.top + b.height / 2), target: el.target }; })()`),
        5000,
      );
      if (!anchor) {
        check(`[${c.name}] the link popup appeared`, false);
        continue;
      }
      const before = opened.length;
      await ui.click(anchor.x, anchor.y);
      await sleep(1200);
      const newly = opened.slice(before);
      const toast = await js("document.querySelector('.Toast')?.textContent ?? null");

      check(`[${c.name}] the window did not navigate`, await intact(), ui.wc.getURL());
      if (c.name === "remote") {
        check("[remote] the link went to the external browser", newly.length === 1 && newly[0] === c.link, newly);
      } else if (c.name === "local") {
        check("[file:] the link was not handed to the OS", newly.length === 0, newly);
        check("[file:] the user sees a refusal", /can't be opened/.test(toast ?? ""), toast);
      } else {
        check("[element link] nothing opened externally", newly.length === 0, newly);
        check("[element link] it was handled in-canvas", /wasn't found/.test(toast ?? ""), toast);
      }
    }

    /* windows the page tries to open */
    let before = opened.length;
    await js(`window.open("file:///System/Applications/Calculator.app"); 1`);
    await sleep(500);
    check("window.open(file:) is not handed to the OS", opened.length === before, opened.slice(before));
    await js(`window.open("https://example.com/x"); 1`);
    await sleep(500);
    check("window.open(https:) opens externally", opened.includes("https://example.com/x"));

    const windowsBefore = BrowserWindow.getAllWindows().length;
    await js(`window.open(${JSON.stringify(`${LIBRARY_ORIGIN}.evil.example/`)}); 1`);
    await sleep(500);
    check("a look-alike library host does not get the in-app window",
      BrowserWindow.getAllWindows().length === windowsBefore);
    await js(`window.open(${JSON.stringify(`${LIBRARY_ORIGIN}/?theme=light`)}); 1`);
    await sleep(800);
    check("the real library origin still opens in-app",
      BrowserWindow.getAllWindows().length === windowsBefore + 1);
    const libWin = BrowserWindow.getAllWindows().find((w) => w !== ui.win);
    const agent = libWin?.webContents.getUserAgent() ?? "";
    check("the library window hides the app and Electron tokens",
      !!agent && !/ExcalidrawDesktop|Electron\//.test(agent) && /Chrome\//.test(agent), agent);
    for (const w of BrowserWindow.getAllWindows()) {
      if (w !== ui.win) w.destroy();
    }

    /* IPC from a page that is not the app, with the same preload */
    for (const [label, load] of [
      ["data: page", (w) => w.loadURL("data:text/html,<p>x</p>")],
      ["other file:// page", (w) => w.loadFile(evil)],
    ]) {
      const foreign = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(ROOT, "electron", "preload.cjs"),
          contextIsolation: true,
          sandbox: true,
        },
      });
      await load(foreign);
      const run = (code) => foreign.webContents.executeJavaScript(code, true);
      check(`[${label}] the preload is present, so the check is what stops it`,
        (await run("typeof window.api")) === "object");
      const read = await run(`window.api.readFile("/etc/hosts").then(r => "ANSWERED", e => "REJECTED")`);
      const write = await run(`window.api.writeFile(${JSON.stringify(ws.file("pwned.txt"))}, "x").then(() => "ANSWERED", e => "REJECTED")`);
      await run("window.api.setDirtyCount(7); 1");
      await sleep(300);
      check(`[${label}] file:read is rejected`, read === "REJECTED", read);
      check(`[${label}] file:write is rejected`, write === "REJECTED", write);
      check(`[${label}] dirty:count is ignored`, !ui.win.isDocumentEdited());
      foreign.destroy();
    }
  } catch (err) {
    fail(err);
  }
  report();
});
