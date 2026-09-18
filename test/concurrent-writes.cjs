/*
 * Overlapping writes: ⌘S during a slow save, Save All on top of it, key
 * repeat, and the session file on every dirty flip. Nothing may end up
 * half-written, and no failure may be reported for a write that worked.
 */
const fs = require("node:fs");
const {
  check, report, fail, sleep, element, countIn,
  workspace, stub, start, dialogs, onDialog, electron,
} = require("./support.cjs");

const { nativeImage } = electron;
const WRITE_MS = 300;

const ws = workspace("concurrent-writes");
const a = ws.drawing("a.excalidraw", [element("a1"), element("a2", { x: 260 })]);
const b = ws.drawing("b.excalidraw", [element("b1")]);
const image = ws.fixture("scale2.excalidraw.png");
ws.session({ open: [a, b, image], active: a });

stub({
  slowWrite: (file) =>
    file.includes(".excalidraw") ? WRITE_MS : file.includes("state.json") ? 120 : 0,
});

const saveErrors = () => dialogs.filter((d) => /Couldn't save/i.test(d));

start(ws).then(async (ui) => {
  try {
    onDialog(() => null);
    await ui.waitTabs(3);

    /* a burst of ⌘S on one drawing */
    await ui.select("a");
    dialogs.length = 0;
    for (let i = 0; i < 8; i++) {
      await ui.menu("save", 40);
    }
    await sleep(4000);
    check("[⌘S burst] the drawing is still valid JSON", countIn(a) === 2, countIn(a));
    check("[⌘S burst] no save was reported as failed", saveErrors().length === 0, saveErrors());
    check("[⌘S burst] no temp files left behind", ws.strayTemps().length === 0, ws.strayTemps());

    /* Save All landing on top of a manual save */
    dialogs.length = 0;
    await ui.menu("save", 30);
    await ui.menu("save-all", 30);
    await ui.menu("save", 30);
    await sleep(4000);
    check("[save + save-all] both drawings are still valid", countIn(a) === 2 && countIn(b) === 1);
    check("[save + save-all] no save was reported as failed", saveErrors().length === 0, saveErrors());
    check("[save + save-all] no temp files left behind", ws.strayTemps().length === 0, ws.strayTemps());

    /* the same for an image, where the export itself is slow */
    await ui.select("scale2");
    dialogs.length = 0;
    for (let i = 0; i < 6; i++) {
      await ui.menu("save", 40);
    }
    await sleep(6000);
    const size = nativeImage.createFromBuffer(fs.readFileSync(image)).getSize();
    check("[PNG burst] the image still decodes at its own size",
      size.width === 960 && size.height === 460, size);
    check("[PNG burst] the scene is still embedded", fs.readFileSync(image).includes("excalidraw"));
    check("[PNG burst] no save was reported as failed", saveErrors().length === 0, saveErrors());
    check("[PNG burst] no temp files left behind", ws.strayTemps().length === 0, ws.strayTemps());

    /* holding ⌘S must not fire a save per repeat */
    await ui.select("a");
    await sleep(500);
    const before = fs.statSync(a).mtimeMs;
    await ui.js(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, repeat: true, bubbles: true, cancelable: true })); 1`);
    await sleep(1500);
    const afterRepeat = fs.statSync(a).mtimeMs;
    await ui.js(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, repeat: false, bubbles: true, cancelable: true })); 1`);
    await sleep(2000);
    check("[key repeat] a repeated ⌘S does not write", afterRepeat === before);
    check("[key repeat] a real ⌘S still writes", fs.statSync(a).mtimeMs !== afterRepeat);

    /* the session file, written on every dirty flip */
    dialogs.length = 0;
    for (let i = 0; i < 12; i++) {
      await ui.js(`document.querySelectorAll('.exd-tab-main')[${i % 3}].click(); 1`);
      await sleep(60);
    }
    await sleep(3000);
    let state = null;
    try {
      state = ws.state();
    } catch (err) {
      state = String(err.message);
    }
    check("[session file] state.json is still valid JSON", typeof state === "object" && state !== null, state);
    check("[session file] it still lists every open drawing", state?.openPaths?.length === 3);
    check("[session file] no temp files left behind", ws.strayTemps().length === 0, ws.strayTemps());
  } catch (err) {
    fail(err);
  }
  report();
});
