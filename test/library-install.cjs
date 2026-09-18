/*
 * The library window can browse anywhere, and whatever it puts in `#addLibrary=`
 * is fetched by the MAIN process. That URL must not be able to point at the
 * local filesystem or a service on the user's own network.
 */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {
  check, report, fail, sleep, waitFor, element,
  workspace, stub, start, dialogs, onDialog, electron,
} = require("./support.cjs");

const { BrowserWindow } = electron;

const LIB_ITEM = JSON.stringify({
  type: "excalidrawlib",
  version: 2,
  source: "test",
  libraryItems: [{ id: "lib1", status: "unpublished", created: 1, elements: [element("li1")] }],
});

/* the "library site", and an intranet service that must never be touched */
const siteHits = [];
const site = http.createServer((req, res) => {
  siteHits.push(req.url);
  if (req.url.startsWith("/lib.excalidrawlib")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(LIB_ITEM);
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>libs</title><p>library site</p>");
});
const secretHits = [];
const secret = http.createServer((req, res) => {
  secretHits.push(req.url);
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("INTERNAL-SERVICE-SECRET");
});
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/* what the main process actually goes out and fetches */
const fetched = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => {
  fetched.push(String(args[0]));
  return realFetch(...args);
};

const ws = workspace("library-install");
ws.session({ open: [ws.drawing("a.excalidraw", [element("a1")])] });

(async () => {
  const sitePort = await listen(site);
  const secretPort = await listen(secret);
  const LIB = `http://127.0.0.1:${sitePort}`;
  const SECRET_URL = `http://127.0.0.1:${secretPort}/admin/keys`;
  process.env.EXD_LIBRARY_ORIGIN = LIB;

  stub();
  const ui = await start(ws);
  try {
    onDialog(() => null);

    const openLibraryWindow = async () => {
      await ui.js(`window.open(${JSON.stringify(`${LIB}/?target=_excalidraw`)}); 1`);
      const win = await waitFor(
        () => BrowserWindow.getAllWindows().find((w) => w !== ui.win) ?? null,
        5000,
      );
      if (win?.webContents.isLoading()) {
        await new Promise((r) => win.webContents.once("did-finish-load", r));
      }
      await sleep(400);
      return win;
    };
    /** Hands `addLibrary=<url>` back the way the real site does. */
    const handBack = async (win, libraryUrl) => {
      await win.webContents.executeJavaScript(
        `location.href = ${JSON.stringify(`${LIB}/return#addLibrary=${encodeURIComponent(libraryUrl)}`)}; 1`,
        true,
      );
      await sleep(1500);
    };

    check("the library window opened", !!(await openLibraryWindow()));

    /* a file: URL must not be fetched */
    dialogs.length = 0;
    fetched.length = 0;
    await handBack(await openLibraryWindow(), "file:///etc/passwd");
    check("a file: library URL is refused", !fetched.some((u) => u.startsWith("file:")), fetched);
    check("the refusal is shown to the user", dialogs.some((d) => /librar/i.test(d)), dialogs);

    /* an intranet service must not be fetched either */
    dialogs.length = 0;
    fetched.length = 0;
    secretHits.length = 0;
    await handBack(await openLibraryWindow(), SECRET_URL);
    check("a plain-http intranet URL is refused", !fetched.includes(SECRET_URL), fetched);
    check("the service saw no request", secretHits.length === 0, secretHits);
    check("that refusal is shown too", dialogs.some((d) => /librar/i.test(d)), dialogs);

    /* the real thing still installs */
    dialogs.length = 0;
    fetched.length = 0;
    const libUrl = `${LIB}/lib.excalidrawlib`;
    await handBack(await openLibraryWindow(), libUrl);
    await sleep(2500);
    check("a library from the library origin is fetched", fetched.includes(libUrl), fetched);
    const stored = await waitFor(() => {
      const items = JSON.parse(fs.readFileSync(path.join(ws.userData, "library.json"), "utf8"));
      return items.length ? items : null;
    }, 8000);
    check("it reached the app and was saved", stored?.length === 1, stored?.length ?? null);
    check("no error on the good path", !dialogs.some((d) => /Couldn't/.test(d)), dialogs);
  } catch (err) {
    fail(err);
  }
  site.close();
  secret.close();
  report();
})();
