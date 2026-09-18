/*
 * Electron exposes the File System Access API but never settles its promises,
 * and browser-fs-access caches that feature detection at module load — leaving
 * every button routed through it (library Open/Save to…, menu Open, image
 * import) silently dead. Deleting the entry points selects the classic
 * <input type="file"> path instead. Must run before the Excalidraw bundle.
 */
const PICKERS = [
  "showOpenFilePicker",
  "showSaveFilePicker",
  "showDirectoryPicker",
] as const;

const removed: string[] = [];
const stubborn: string[] = [];

for (const name of PICKERS) {
  if (!(name in window)) {
    continue;
  }
  try {
    delete (window as any)[name];
  } catch {
    /* checked below */
  }
  if (name in window) {
    stubborn.push(name);
  } else {
    removed.push(name);
  }
}

if (import.meta.env.DEV) {
  // eslint-disable-next-line no-console
  console.log(
    `[exd] File System Access API removed: ${removed.join(", ") || "(none)"}` +
      (stubborn.length ? ` / could not remove: ${stubborn.join(", ")}` : ""),
  );
}

export const removedPickers = removed;
export const stubbornPickers = stubborn;
