/*
 * Reloading the window throws away every unsaved drawing, since they live only
 * in the renderer. A built app must not offer ⌘R at all, and any other unload
 * has to ask first — without blocking an ordinary close.
 */
const {
  check, report, fail, sleep, element, countIn,
  workspace, stub, start, dialogs, onDialog, electron,
} = require("./support.cjs");

const { Menu } = electron;
const RELOAD = /Reloading will discard/;
const UNSAVED = /unsaved changes/;

const ws = workspace("reload-guard");
const drawing = ws.drawing("drawing.excalidraw", [element("a1")]);
ws.session({ open: [drawing] });

stub();

start(ws).then(async (ui) => {
  try {
    /* the built app's View menu */
    const view = Menu.getApplicationMenu().items.find((i) => i.label === "View");
    const labels = view.submenu.items.map((i) => i.label).filter(Boolean);
    check("[packaged] no Reload in the View menu", !labels.some((l) => /reload/i.test(l)), labels);
    check("[packaged] no DevTools without the debug flag",
      !labels.some((l) => /developer tools/i.test(l)), labels);

    const mark = () => ui.js("window.__stillHere = 1; 1");
    const survived = () => ui.js("window.__stillHere === 1");

    /* a reload with unsaved work: asked about, and cancellable */
    await ui.draw({ settle: 0 });
    await ui.waitDirty("drawing");
    await mark();
    dialogs.length = 0;
    onDialog(() => null); // Cancel
    ui.wc.reload();
    await sleep(2000);
    check("[dirty] reloading asks first", dialogs.some((m) => RELOAD.test(m)), dialogs);
    check("[dirty] Cancel keeps the page and the unsaved work", await survived());
    check("[dirty] the drawing is untouched on disk", countIn(drawing) === 1, countIn(drawing));

    /* the same, confirmed */
    dialogs.length = 0;
    onDialog((o) => (RELOAD.test(o.message) ? 0 : null)); // "Reload and Discard"
    ui.wc.reload();
    await sleep(2500);
    await ui.ready();
    check("[dirty] confirming actually reloads", (await survived()) === false);
    check("[dirty] the discarded edit never reached the file", countIn(drawing) === 1, countIn(drawing));

    /* a reload with nothing unsaved must not ask */
    await mark();
    dialogs.length = 0;
    onDialog(() => null);
    ui.wc.reload();
    await sleep(2500);
    await ui.ready();
    check("[clean] reloading asks nothing", dialogs.length === 0, dialogs);
    check("[clean] the page did reload", (await survived()) === false);

    /* closing must still work with the unload guard in place */
    await ui.draw({ settle: 0 });
    await ui.waitDirty("drawing");
    dialogs.length = 0;
    onDialog((o) => (UNSAVED.test(o.message) ? 1 : null)); // "Close Without Saving"
    await ui.win.close();
    await sleep(2500);
    check("[close] the window still closes", ui.win.isDestroyed(), dialogs);
  } catch (err) {
    fail(err);
  }
  report();
});
