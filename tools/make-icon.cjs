/*
 * Draws build/icon.png with rough.js, the renderer Excalidraw itself uses, so
 * the strokes match the app. Also writes tools/.out/icon-preview.png showing it
 * at Dock, list and Finder sizes — the sizes that decide whether an icon works.
 *
 *   npx electron tools/make-icon.cjs
 */
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "build", "icon.png");
const WORK = path.join(__dirname, ".out");
const ROUGH = path.join(ROOT, "node_modules", "roughjs", "bundled", "rough.js");

fs.mkdirSync(WORK, { recursive: true });

const page = `<!doctype html><meta charset="utf-8">
<body style="margin:0">
<script src="file://${ROUGH}"></script>
<script>
const S = 1024;      // icon canvas
const M = 100;       // Apple's grid: the art lives in the middle 824
const CREAM = "#f7f2e7";
const INK = "#1b1b1f";
const BLUE = "#9cc9f5";
const RED = "#e2563f";

const squircle = (ctx) => {
  const r = 200, a = M, b = S - M;
  ctx.beginPath();
  ctx.moveTo(a + r, a);
  ctx.arcTo(b, a, b, a + r, r);
  ctx.arcTo(b, b, b - r, b, r);
  ctx.arcTo(a, b, a, b - r, r);
  ctx.arcTo(a, a, a + r, a, r);
  ctx.closePath();
  return { a, b, w: b - a };
};

/* A sidebar of drawings next to one hand-drawn shape: at 16px the red strip and
   the blue shape are all that survive, and they are enough to tell it apart. */
const draw = (ctx, rc) => {
  ctx.clearRect(0, 0, S, S);
  const box = squircle(ctx);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 18;
  ctx.fillStyle = CREAM;
  ctx.fill();
  ctx.restore();

  ctx.save();
  squircle(ctx);
  ctx.clip();
  ctx.fillStyle = RED;
  ctx.fillRect(box.a, box.a, 260, box.w);
  ctx.restore();

  ctx.fillStyle = "rgba(255,255,255,0.95)";
  for (const y of [330, 462, 594]) {
    ctx.beginPath();
    ctx.roundRect(142, y, 176, 84, 26);
    ctx.fill();
  }

  rc.rectangle(430, 370, 380, 300, {
    stroke: INK, strokeWidth: 16, roughness: 1.6, seed: 23,
    fill: BLUE, fillStyle: "solid",
  });
};

window.icon = () => {
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  draw(canvas.getContext("2d"), rough.canvas(canvas));
  return canvas.toDataURL("image/png").split(",")[1];
};

window.preview = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 360;
  canvas.height = 200;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#d8d8dc";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 20, 20, 128, 128);
      ctx.drawImage(img, 180, 20, 32, 32);
      ctx.drawImage(img, 240, 28, 16, 16);
      ctx.fillStyle = "#222";
      ctx.font = "16px -apple-system, sans-serif";
      ctx.fillText("128 · 32 · 16", 180, 90);
      resolve(canvas.toDataURL("image/png").split(",")[1]);
    };
    img.src = "data:image/png;base64," + window.icon();
  });
};
</script>`;

app.whenReady().then(async () => {
  let failed = false;
  try {
    const pagePath = path.join(WORK, "icon-page.html");
    fs.writeFileSync(pagePath, page);
    const win = new BrowserWindow({ show: false, width: 200, height: 200 });
    await win.loadFile(pagePath);
    const icon = await win.webContents.executeJavaScript("window.icon()", true);
    fs.writeFileSync(OUT, Buffer.from(icon, "base64"));
    const preview = await win.webContents.executeJavaScript("window.preview()", true);
    fs.writeFileSync(path.join(WORK, "icon-preview.png"), Buffer.from(preview, "base64"));
    console.log("wrote build/icon.png and tools/.out/icon-preview.png");
  } catch (err) {
    failed = true;
    console.log("ERROR", err?.message ?? String(err));
  }
  app.exit(failed ? 1 : 0);
});
