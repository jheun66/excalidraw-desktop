/*
 * Closing with unsaved work. A failed save must never close the tab or the
 * window, every new window must ask again, and ⌘Q must go through with the
 * quit once the save lands.
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  check, report, fail, sleep, countIn, element, scene,
  workspace, stub, start, ui, dialogs, onDialog, electron,
} = require("./support.cjs");

const { app, BrowserWindow } = electron;

const ws = workspace("closing");
// One drawing lives in a folder we can make read-only, so its saves fail.
const readOnly = path.join(ws.dir, "locked");
fs.mkdirSync(readOnly, { recursive: true });
const locked = path.join(readOnly, "locked.excalidraw");
fs.writeFileSync(locked, scene([element("l1")]));
const plain = ws.drawing("plain.excalidraw", [element("p1")]);
ws.session({ open: [locked, plain], active: locked });

const lock = () => fs.chmodSync(readOnly, 0o555);
const unlock = () => fs.chmodSync(readOnly, 0o755);
const UNSAVED = /unsaved changes/;

stub();

start(ws).then(async (view) => {
  let ui1 = view;
  try {
    await ui1.waitTabs(2);

    /* ⌘W with a save that fails */
    await ui1.select("locked");
    await ui1.draw();
    check("the drawing is dirty", await ui1.waitDirty("locked"));
    lock();
    dialogs.length = 0;
    onDialog((o) => (UNSAVED.test(o.message) ? 0 : null)); // "Save"
    await ui1.menu("close");
    check("[⌘W, save fails] asked, then told it failed",
      UNSAVED.test(dialogs[0] ?? "") && /Couldn't save/.test(dialogs[1] ?? ""), dialogs);
    check("[⌘W, save fails] the tab stays open and unsaved", await ui1.waitDirty("locked"));
    check("[⌘W, save fails] the file is untouched", countIn(locked) === 1, countIn(locked));

    /* the same once the folder is writable */
    unlock();
    await ui1.menu("close");
    check("[⌘W, save works] the tab closes", (await ui1.tab("locked")) === null);
    check("[⌘W, save works] the edit is on disk", countIn(locked) === 2, countIn(locked));

    /* closing the window with a save that fails */
    await ui1.openPath(locked);
    await ui1.select("locked");
    await ui1.draw();
    check("the drawing is dirty again", await ui1.waitDirty("locked"));
    lock();
    dialogs.length = 0;
    await ui1.win.close();
    await sleep(2000);
    check("[close, save fails] the window stays open", !ui1.win.isDestroyed(), dialogs);
    check("[close, save fails] it is still unsaved", !ui1.win.isDestroyed() && (await ui1.waitDirty("locked")));

    /* and it asks again rather than getting stuck */
    dialogs.length = 0;
    onDialog(() => null); // Cancel
    await ui1.win.close();
    await sleep(800);
    check("[close again] it asks again", dialogs.some((m) => UNSAVED.test(m)), dialogs);
    check("[close again] Cancel keeps the window", !ui1.win.isDestroyed());

    unlock();
    dialogs.length = 0;
    onDialog((o) => (UNSAVED.test(o.message) ? 0 : null));
    await ui1.win.close();
    await sleep(2000);
    check("[close, save works] the window closes", ui1.win.isDestroyed());
    check("[close, save works] the edit is on disk", countIn(locked) === 3, countIn(locked));

    /* a window reopened from the Dock must ask too */
    app.emit("activate");
    await sleep(500);
    ui1 = ui(BrowserWindow.getAllWindows()[0]);
    await ui1.ready();
    await ui1.waitTabs(2);
    await ui1.select("plain");
    await ui1.draw();
    check("[reopened] the drawing is dirty", await ui1.waitDirty("plain"));
    dialogs.length = 0;
    onDialog(() => null);
    await ui1.win.close();
    await sleep(800);
    check("[reopened] closing asks first", dialogs.some((m) => UNSAVED.test(m)), dialogs);
    check("[reopened] Cancel keeps it open", !ui1.win.isDestroyed());

    /* a crashed renderer must not pin the window open */
    ui1.wc.forcefullyCrashRenderer();
    await sleep(1000);
    await ui1.win.close();
    await sleep(800);
    check("[renderer crashed] the window can still be closed", ui1.win.isDestroyed());

    /* an edit closed inside the dirty-flag delay */
    app.emit("activate");
    await sleep(500);
    ui1 = ui(BrowserWindow.getAllWindows()[0]);
    await ui1.ready();
    await ui1.select("plain");
    const before = countIn(plain);
    dialogs.length = 0;
    onDialog((o) => (UNSAVED.test(o.message) ? 0 : null)); // "Save and Close"
    await ui1.draw({ settle: 0 });
    await ui1.win.close();
    await sleep(2500);
    check("[edit then close at once] closing still asks", dialogs.some((m) => UNSAVED.test(m)), dialogs);
    check("[edit then close at once] the edit was saved", countIn(plain) === before + 1, countIn(plain));

    /* ⌘Q has to finish the quit after saving */
    app.emit("activate");
    await sleep(500);
    ui1 = ui(BrowserWindow.getAllWindows()[0]);
    await ui1.ready();
    await ui1.select("plain");
    await ui1.draw();
    const beforeQuit = countIn(plain);
    let quit = false;
    app.once("will-quit", (e) => {
      quit = true;
      e.preventDefault(); // stay alive to report
    });
    dialogs.length = 0;
    app.quit();
    await sleep(3000);
    check("[⌘Q] asks about unsaved work", dialogs.some((m) => UNSAVED.test(m)), dialogs);
    check("[⌘Q] saves and closes the window",
      ui1.win.isDestroyed() && countIn(plain) === beforeQuit + 1, countIn(plain));
    check("[⌘Q] the app goes on to quit", quit);
  } catch (err) {
    fail(err);
  }
  try {
    unlock();
  } catch {
    /* already writable */
  }
  report();
});
