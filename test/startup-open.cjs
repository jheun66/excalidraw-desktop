/*
 * A file double-clicked in Finder while the app is starting must end up the
 * active tab, and must not open twice when the saved session contains it too.
 * The path is passed on the command line, the way the OS hands one over.
 *
 *   EXD_CASE=duplicate  the queued file is also in the saved session (slow read)
 *   EXD_CASE=outside    the queued file is not in the session
 */
const path = require("node:path");
const {
  check, report, fail, sleep, waitFor, element,
  workspace, stub, start, onDialog,
} = require("./support.cjs");

const CASE = process.env.EXD_CASE || "duplicate";

const ws = workspace(`startup-open-${CASE}`);
const slow = ws.drawing("slow.excalidraw", [element("s1")]);
const other = ws.drawing("other.excalidraw", [element("o1")]);
const outside = ws.drawing("outside.excalidraw", [element("x1")]);
const queued = CASE === "duplicate" ? slow : outside;
ws.session({ open: CASE === "duplicate" ? [slow, other] : [other, slow], active: other });

// "slow" takes a while to come off disk, so the restore is still running when
// the OS hands its path over.
stub({ slowRead: true });

start(ws, { argv: [queued], waitForCanvas: false }).then(async (ui) => {
  try {
    onDialog(() => null);
    const expected = CASE === "duplicate" ? 2 : 3;
    await waitFor(async () => (await ui.tabs()).length >= expected);
    await sleep(3000); // let the slow read and everything after it finish

    const tabs = await ui.tabs();
    const active = await ui.js("document.querySelector('.exd-tab.is-active .exd-tab-name')?.firstChild?.textContent ?? null");
    const wanted = path.basename(queued).replace(".excalidraw", "");

    check(`[${CASE}] the double-clicked file is the active tab`, active === wanted, { active, wanted });
    check(`[${CASE}] it is open exactly once`,
      tabs.filter((t) => t.name === wanted).length === 1, tabs.map((t) => t.name));
    check(`[${CASE}] the session files are all open`, tabs.length === expected, tabs.map((t) => t.name));
  } catch (err) {
    fail(err);
  }
  report();
});
