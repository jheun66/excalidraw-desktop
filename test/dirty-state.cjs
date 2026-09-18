/*
 * Unsaved edits must survive a remount — switching tabs, renaming — and an
 * emptied drawing must not be mistaken for one that failed to load.
 */
const {
  check, report, fail, sleep, waitFor, element, countIn,
  workspace, stub, start, dialogs, onDialog,
} = require("./support.cjs");

const ws = workspace("dirty-state");
const files = {
  alpha: ws.drawing("alpha.excalidraw", [element("a1")]),
  beta: ws.drawing("beta.excalidraw", [element("b1")]),
  gamma: ws.drawing("gamma.excalidraw", [element("c1")]),
  // A type Excalidraw's restore drops: the scene comes up empty from a file
  // that is not.
  delta: ws.drawing("delta.excalidraw", [element("d1", { type: "bogus-shape" })]),
};
ws.session({ open: Object.values(files), active: files.alpha });

stub();

start(ws).then(async (ui) => {
  try {
    await ui.waitTabs(4);
    onDialog(() => null); // Cancel

    /* opening: no false "unsaved", and real breakage still caught */
    for (const name of ["alpha", "beta", "gamma", "delta"]) {
      await ui.select(name);
    }
    for (const name of ["alpha", "beta", "gamma"]) {
      const tab = await ui.tab(name);
      check(`[open] ${name} is clean and not broken`, tab && !tab.dirty && !tab.broken, tab);
    }
    check("[open] delta is flagged broken", (await ui.tab("delta"))?.broken === true);

    /* an edit has to survive switching away and back */
    await ui.select("alpha");
    await ui.draw();
    check("[switch] alpha is dirty after drawing", await ui.waitDirty("alpha"));
    await ui.select("beta");
    await ui.select("alpha");
    check("[switch] alpha is still dirty", await ui.waitDirty("alpha"));

    await ui.menu("save-all");
    check("[switch] Save All writes the edit", countIn(files.alpha) === 2, countIn(files.alpha));
    check("[switch] alpha is clean afterwards", await ui.waitDirty("alpha", false));

    await ui.draw({ offset: 130 });
    check("[switch] alpha is dirty after a second edit", await ui.waitDirty("alpha"));
    await ui.select("beta");
    await ui.select("alpha");
    dialogs.length = 0;
    await ui.menu("close");
    check("[switch] ⌘W asks before discarding", dialogs.some((m) => /alpha.*unsaved/.test(m)), dialogs);
    check("[switch] Cancel keeps the tab", !!(await ui.tab("alpha")));
    await ui.menu("save-all");
    check("[switch] Save All writes the second edit", countIn(files.alpha) === 3, countIn(files.alpha));

    /* a drawing emptied on purpose is not broken */
    await ui.select("gamma");
    const box = await ui.box();
    await ui.click(Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2));
    await ui.key("Delete");
    check("[empty] gamma is dirty after deleting its only element", await ui.waitDirty("gamma"));
    await ui.select("beta");
    await ui.select("gamma");
    const gamma = await ui.tab("gamma");
    check("[empty] gamma is not flagged broken", gamma && !gamma.broken && !(await ui.notice()), gamma);
    check("[empty] gamma is still dirty", gamma?.dirty === true, gamma);
    await ui.menu("save-all");
    check("[empty] Save All writes the empty drawing", countIn(files.gamma) === 0, countIn(files.gamma));
    await ui.select("alpha");
    await ui.select("gamma");
    const reopened = await ui.tab("gamma");
    check("[empty] it stays healthy and clean on remount", reopened && !reopened.broken && !reopened.dirty, reopened);

    /* renaming remounts the canvas too */
    await ui.select("beta");
    await ui.draw();
    check("[rename] beta is dirty after drawing", await ui.waitDirty("beta"));
    await ui.js(`(() => {
      const t = [...document.querySelectorAll('.exd-tab')].find(t => t.querySelector('.exd-tab-name')?.firstChild?.textContent === "beta");
      t.querySelector('.exd-tab-main').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return 1;
    })()`);
    await waitFor(() => ui.js("document.activeElement?.classList.contains('exd-rename')"), 3000);
    ui.wc.insertText("beta2");
    await ui.key("Return");
    await sleep(1500);
    check("[rename] the renamed tab is still dirty", await ui.waitDirty("beta2"), await ui.tab("beta2"));
    await ui.menu("save-all");
    const renamed = ws.file("beta2.excalidraw");
    check("[rename] Save All writes to the new name", countIn(renamed) === 2, countIn(renamed));
  } catch (err) {
    fail(err);
  }
  report();
});
