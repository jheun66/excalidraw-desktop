import { getCommonBounds } from "@excalidraw/excalidraw";

/*
 * Excalidraw keeps scale, background and dark mode out of the scene it embeds,
 * so a reopened image carries only defaults and saving would rewrite it — a 2×
 * export back at 1×, a transparent one with a background, a dark one light.
 * They are recovered from the file instead: an SVG states them, a PNG is
 * measured against the scene inside it.
 */
export type ExportSettings = {
  scale: number;
  background: boolean;
  darkMode: boolean;
};

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  scale: 1,
  background: true,
  darkMode: false,
};

/** Excalidraw's DEFAULT_EXPORT_PADDING, which the package does not export. */
const EXPORT_PADDING = 10;
const KNOWN_SCALES = [1, 2, 3];
const SNAP_TOLERANCE = 0.15;

const snapScale = (raw: number): number => {
  if (!Number.isFinite(raw) || raw <= 0) {
    return 1;
  }
  for (const scale of KNOWN_SCALES) {
    if (Math.abs(raw - scale) <= SNAP_TOLERANCE) {
      return scale;
    }
  }
  return Math.min(4, Math.max(0.25, Math.round(raw * 100) / 100));
};

/** The width an unscaled export of these elements would have. */
const unscaledWidth = (elements: readonly any[]): number | null => {
  const live = elements.filter((el) => !el?.isDeleted);
  if (!live.length) {
    return null;
  }
  const [minX, , maxX] = getCommonBounds(live as any);
  const width = Math.abs(maxX - minX) + EXPORT_PADDING * 2;
  return width > 0 ? width : null;
};

export const settingsFromSvg = (markup: string): ExportSettings => {
  try {
    const svg = new DOMParser().parseFromString(markup, "image/svg+xml")
      .documentElement;
    if (!svg || svg.nodeName === "parsererror") {
      return DEFAULT_EXPORT_SETTINGS;
    }
    const viewBox = (svg.getAttribute("viewBox") ?? "")
      .split(/[\s,]+/)
      .map(Number);
    const boxWidth = viewBox.length === 4 && viewBox[2] > 0 ? viewBox[2] : null;
    const width = parseFloat(svg.getAttribute("width") ?? "");
    return {
      scale: boxWidth && Number.isFinite(width) ? snapScale(width / boxWidth) : 1,
      background: [...svg.querySelectorAll("rect")].some(
        (rect) =>
          rect.getAttribute("x") === "0" &&
          rect.getAttribute("y") === "0" &&
          !!boxWidth &&
          parseFloat(rect.getAttribute("width") ?? "0") >= boxWidth,
      ),
      darkMode: (svg.getAttribute("filter") ?? "").includes("invert"),
    };
  } catch {
    return DEFAULT_EXPORT_SETTINGS;
  }
};

const luminance = (r: number, g: number, b: number) =>
  (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Via the canvas, so named colours resolve too. */
const colorLuminance = (
  ctx: CanvasRenderingContext2D,
  color: string | undefined,
): number | null => {
  if (!color || color === "transparent") {
    return null;
  }
  try {
    ctx.fillStyle = "#000000";
    ctx.fillStyle = color;
    const resolved = String(ctx.fillStyle);
    const hex = /^#([0-9a-f]{6})$/i.exec(resolved);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return luminance((n >> 16) & 255, (n >> 8) & 255, n & 255);
    }
    const rgb = /rgba?\(([^)]+)\)/i.exec(resolved);
    if (rgb) {
      const [r, g, b] = rgb[1].split(",").map((v) => parseFloat(v));
      return luminance(r, g, b);
    }
  } catch {
    /* fall through */
  }
  return null;
};

/** A background this far from the scene's own colour means it was exported dark. */
const DARK_MODE_DELTA = 0.35;

/** Corner pixels sit inside the export padding, so they are the background. */
export const settingsFromPng = async (
  dataUrl: string,
  elements: readonly any[],
  viewBackgroundColor: string | undefined,
): Promise<ExportSettings> => {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    const unscaled = unscaledWidth(elements);
    const scale = unscaled ? snapScale(width / unscaled) : 1;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx || width < 6 || height < 6) {
      return { ...DEFAULT_EXPORT_SETTINGS, scale };
    }
    ctx.drawImage(img, 0, 0);
    const corners = [
      [2, 2],
      [width - 3, 2],
      [2, height - 3],
      [width - 3, height - 3],
    ].map(([x, y]) => ctx.getImageData(x, y, 1, 1).data);

    const opaque = corners.filter((px) => px[3] > 250);
    const background = opaque.length >= 3;
    let darkMode = false;
    if (background) {
      const sceneLuminance = colorLuminance(ctx, viewBackgroundColor);
      const pixel = opaque[0];
      if (sceneLuminance !== null) {
        darkMode =
          Math.abs(luminance(pixel[0], pixel[1], pixel[2]) - sceneLuminance) >
          DARK_MODE_DELTA;
      }
    }
    return { scale, background, darkMode };
  } catch {
    return DEFAULT_EXPORT_SETTINGS;
  }
};
