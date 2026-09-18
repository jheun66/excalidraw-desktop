/*
 * Renaming, the broken-scene mark, and ⌘N: none of them may touch a drawing
 * they were not meant to.
 */
const fs = require("node:fs");
const {
  check, report, fail, sleep, waitFor, element, scene, countIn,
  workspace, stub, start, dialogs, onDialog,
} = require("./support.cjs");

const ws = workspace("file-operations");
const PACKAGE = JSON.stringify({ name: "my-project", version: "1.2.3" }, null, 2);
// An element type Excalidraw drops: the scene comes up empty, so the file is
// marked broken.
const bad = ws.drawing("bad.excalidraw", [element("d1", { type: "bogus-shape" })]);
const flow = ws.drawing("Flow.excalidraw", [element("f1")]);
const keep = ws.drawing("keep.excalidraw", [element("k1"), element("k2")]);
const suffixed = ws.drawing("newone.excalidraw", [element("s1"), element("s2"), element("s3")]);
ws.session({ open: [bad, flow, keep], active: bad });

let savePath = null;
stub({ saveDialog: () => savePath });

const drawings = () => fs.readdirSync(ws.dir).filter((n) => n.endsWith(".excalidraw"));

start(ws).then(async (ui) => {
  try {
    onDialog(() => null);
    await ui.waitTabs(3);

    /* broken, then fixed outside the app */
    await ui.select("bad");
    check("[broken] a file that cannot be restored opens broken", (await ui.tab("bad"))?.broken === true);
    await ui.menu("close", 1200);
    check("[broken] its tab closes", (await ui.tab("bad")) === null);
    fs.writeFileSync(bad, scene([element("d1")])); // repaired elsewhere
    await ui.openPath(bad);
    await waitFor(() => ui.tab("bad"));
    await sleep(1500);
    check("[broken] reopening the repaired file is not broken", (await ui.tab("bad"))?.broken === false);
    await ui.select("bad");
    await ui.draw();
    await ui.menu("save");
    await waitFor(() => countIn(bad) === 2 || null, 8000);
    check("[broken] and it can be saved again", countIn(bad) === 2, countIn(bad));

    /* renaming Flow → flow, which is the same file on a case-insensitive disk */
    await ui.select("Flow");
    dialogs.length = 0;
    await ui.js(`(() => {
      const t = [...document.querySelectorAll('.exd-tab')].find(t => t.querySelector('.exd-tab-name')?.firstChild?.textContent === "Flow");
      t.querySelector('.exd-tab-main').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return 1;
    })()`);
    await waitFor(() => ui.js("document.activeElement?.classList.contains('exd-rename')"), 3000);
    ui.wc.insertText("flow");
    await ui.key("Return");
    await sleep(1500);
    check("[case rename] no error was reported", dialogs.length === 0, dialogs);
    check("[case rename] the file on disk is now lower case",
      drawings().includes("flow.excalidraw") && !drawings().includes("Flow.excalidraw"), drawings());
    check("[case rename] the tab followed", (await ui.tab("flow")) !== null);

    /* ⌘N pointed at a drawing that is open */
    dialogs.length = 0;
    savePath = keep;
    await ui.menu("new");
    check("[⌘N on an open file] it is refused", dialogs.some((d) => /already open/.test(d)), dialogs);
    check("[⌘N on an open file] the drawing is untouched", countIn(keep) === 2, countIn(keep));

    /* ⌘N where the extension had to be added and that file exists */
    dialogs.length = 0;
    savePath = ws.file("newone"); // the dialog only warned about "newone"
    await ui.menu("new");
    check("[⌘N adds the extension] an existing file is not replaced", countIn(suffixed) === 3, countIn(suffixed));
    check("[⌘N adds the extension] the user is told", dialogs.some((d) => /already exists/.test(d)), dialogs);

    /* and a genuinely new file still works */
    dialogs.length = 0;
    savePath = ws.file("fresh");
    await ui.menu("new");
    await waitFor(() => ui.tab("fresh"), 8000);
    check("[⌘N] a new drawing is created and opened",
      fs.existsSync(ws.file("fresh.excalidraw")) && (await ui.tab("fresh")) !== null, drawings());
    check("[⌘N] no error for the new file", dialogs.length === 0, dialogs);
  } catch (err) {
    fail(err);
  }
  report();
});
