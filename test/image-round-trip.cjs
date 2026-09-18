/*
 * Saving a .excalidraw.png / .excalidraw.svg gives the file back as it was:
 * same pixel size (scale), same background, same light/dark. The fixtures are
 * real Excalidraw exports — see tools/make-fixtures.cjs.
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  check, report, fail, sleep, FIXTURES,
  workspace, stub, start, onDialog, electron,
} = require("./support.cjs");

const { nativeImage } = electron;

const ws = workspace("image-round-trip");
const names = fs.readdirSync(FIXTURES);
const before = new Map();
for (const name of names) {
  ws.fixture(name);
  before.set(name, fs.readFileSync(path.join(FIXTURES, name)));
}
ws.session({ open: names.map((n) => ws.file(n)) });

/** Pixel size, corner pixels and whether the scene survived. */
const pngInfo = (buffer) => {
  const img = nativeImage.createFromBuffer(buffer);
  const { width, height } = img.getSize();
  const bmp = img.getBitmap(); // BGRA
  const at = (x, y) => {
    const o = (y * width + x) * 4;
    return { b: bmp[o], g: bmp[o + 1], r: bmp[o + 2], a: bmp[o + 3] };
  };
  const corners = [at(2, 2), at(width - 3, 2), at(2, height - 3), at(width - 3, height - 3)];
  const opaque = corners.filter((c) => c.a > 250);
  return {
    width,
    height,
    opaqueCorners: opaque.length,
    luminance: opaque.length
      ? Math.round(((0.2126 * opaque[0].r + 0.7152 * opaque[0].g + 0.0722 * opaque[0].b) / 255) * 100) / 100
      : null,
    hasScene: buffer.includes("excalidraw"),
  };
};
const svgInfo = (buffer) => {
  const text = buffer.toString("utf8");
  const attr = (name) => new RegExp(`<svg[^>]*\\s${name}="([^"]*)"`).exec(text)?.[1] ?? null;
  return {
    width: attr("width"),
    height: attr("height"),
    darkFilter: /<svg[^>]*filter="[^"]*invert/.test(text),
    background: /<rect[^>]*x="0"[^>]*y="0"/.test(text),
    hasScene: text.includes("<metadata>"),
  };
};
const info = (buffer, name) => (name.endsWith(".png") ? pngInfo(buffer) : svgInfo(buffer));

stub();

start(ws).then(async (ui) => {
  try {
    onDialog(() => null);
    await ui.waitTabs(names.length);

    for (const name of names) {
      const label = name.replace(/\.excalidraw\.(png|svg)$/, "");
      if (!(await ui.select(label))) {
        check(`[${label}] the tab is there`, false, await ui.tabs());
        continue;
      }
      const notice = await ui.notice();
      if (notice) {
        check(`[${label}] opened for editing`, false, notice.slice(0, 80));
        continue;
      }

      const was = info(before.get(name), name);
      const file = ws.file(name);
      await ui.menu("save", 0);
      await sleep(3000);
      const now = info(fs.readFileSync(file), name);

      if (name.endsWith(".png")) {
        check(`[${label}] pixel size kept`, was.width === now.width && was.height === now.height,
          { was: `${was.width}x${was.height}`, now: `${now.width}x${now.height}` });
        check(`[${label}] background kept`, was.opaqueCorners === now.opaqueCorners);
        check(`[${label}] light/dark kept`,
          was.luminance === null ? now.luminance === null : Math.abs(was.luminance - now.luminance) < 0.15,
          { was: was.luminance, now: now.luminance });
      } else {
        check(`[${label}] size attributes kept`, was.width === now.width && was.height === now.height,
          { was: `${was.width}x${was.height}`, now: `${now.width}x${now.height}` });
        check(`[${label}] background kept`, was.background === now.background);
        check(`[${label}] light/dark kept`, was.darkFilter === now.darkFilter);
      }
      check(`[${label}] the scene is still embedded`, now.hasScene === true);
    }

    /* saving twice must not drift */
    const png = names.find((n) => n.endsWith(".png"));
    const first = fs.readFileSync(ws.file(png));
    await ui.select(png.replace(/\.excalidraw\.png$/, ""));
    await ui.menu("save", 2500);
    const a = pngInfo(first);
    const b = pngInfo(fs.readFileSync(ws.file(png)));
    check("saving twice keeps the same size", a.width === b.width && a.height === b.height, { a, b });
  } catch (err) {
    fail(err);
  }
  report();
});
