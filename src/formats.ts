/**
 * `.excalidraw`/`.excalidraw.json` are scene JSON; the image formats carry the
 * scene inside them, so a save has to write back the same wrapper.
 */
export type SceneFormat = "json" | "png" | "svg";

export const formatOf = (filePath: string): SceneFormat => {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) {
    return "png";
  }
  if (lower.endsWith(".svg")) {
    return "svg";
  }
  return "json";
};

export const OPENABLE_EXTENSIONS = [
  "excalidraw",
  "excalidraw.json",
  "excalidraw.png",
  "excalidraw.svg",
  "json",
  "png",
  "svg",
] as const;

/** `flow.excalidraw.png` reads as `flow`: the whole extension chain comes off. */
export const displayName = (fileName: string) =>
  fileName
    .replace(/\.excalidraw\.(json|png|svg)$/i, "")
    .replace(/\.excalidraw$/i, "")
    .replace(/\.(json|png|svg)$/i, "");

export const isBinary = (format: SceneFormat) => format === "png";
