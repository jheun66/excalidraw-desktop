/*
 * Excalidraw resolves its scene fonts against this; left unset it resolves them
 * against the bundled JS chunks, every request 404s, and the canvas falls back
 * to a system serif. Must run before the Excalidraw bundle registers its fonts.
 */
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

window.EXCALIDRAW_ASSET_PATH = new URL(".", document.baseURI).href;

export {};
