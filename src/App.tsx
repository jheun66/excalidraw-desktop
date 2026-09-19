import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  Excalidraw,
  exportToBlob,
  exportToSvg,
  getSceneVersion,
  isElementLink,
  loadFromBlob,
  serializeAsJSON,
} from "@excalidraw/excalidraw";

import Sidebar from "./Sidebar";
import { dlog, dtime, setDebugEnabled, watchFonts } from "./debug";
import {
  DEFAULT_EXPORT_SETTINGS,
  settingsFromPng,
  settingsFromSvg,
} from "./export-settings";
import type { ExportSettings } from "./export-settings";
import { displayName, formatOf } from "./formats";
import type { SceneFormat } from "./formats";
import { normalizeBoundText } from "./normalize";
import { sceneSignature } from "./signature";
import type { OpenFile } from "./types";

const DIRTY_CHECK_MS = 250;

const applyGlass = (level: string | undefined) => {
  const root = document.documentElement;
  if (level === "clear" || level === "frosted") {
    root.dataset.glass = level;
  } else {
    delete root.dataset.glass;
  }
};

const fileInfo = (filePath: string) => {
  const fileName = filePath.split("/").pop() ?? filePath;
  return {
    path: filePath,
    fileName,
    name: displayName(fileName),
    dir: filePath.slice(0, filePath.length - fileName.length - 1),
  };
};

const errorTab = (
  info: ReturnType<typeof fileInfo>,
  error: string,
): OpenFile => ({ ...info, scene: null, error, dirty: false, savedAt: null });

/*
 * `.json` is one of this app's file types, so ⌘O and Finder hand over any JSON.
 * Unchecked, a package.json would open as an empty canvas and ⌘S would write an
 * empty scene over it.
 */
const isSceneJSON = (value: any) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (value.type === "excalidraw" || Array.isArray(value.elements));

const readEmbeddedScene = async (
  filePath: string,
  format: "png" | "svg",
): Promise<{ file: OpenFile; settings: ExportSettings }> => {
  const base = { ...fileInfo(filePath), dirty: false, savedAt: null };
  const fail = (error: string) => ({
    file: { ...base, scene: null, error },
    settings: DEFAULT_EXPORT_SETTINGS,
  });
  const r = await window.api.readFileBase64(filePath);
  if (!r.base64) {
    return fail(r.error ?? "This file can't be read.");
  }
  try {
    const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], {
      type: format === "png" ? "image/png" : "image/svg+xml",
    });
    const restored = await loadFromBlob(blob, null, null);
    const scene = {
      elements: restored.elements,
      appState: restored.appState,
      files: restored.files ?? {},
    };
    const normalized = normalizeBoundText(scene);
    const settings =
      format === "png"
        ? await settingsFromPng(
            `data:image/png;base64,${r.base64}`,
            scene.elements ?? [],
            scene.appState?.viewBackgroundColor,
          )
        : settingsFromSvg(new TextDecoder().decode(bytes));
    dlog(`export settings ${base.fileName}`, settings);
    return {
      file: { ...base, scene: normalized.moved > 0 ? normalized.scene : scene },
      settings,
    };
  } catch (err: any) {
    return fail(
      `This ${format.toUpperCase()} has no Excalidraw scene in it. ` +
        'Only images exported with "Embed scene" turned on can be edited.',
    );
  }
};

const blobToBase64 = async (blob: Blob) => {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // Chunked: a large image would blow the argument limit.
  for (let i = 0; i < buf.length; i += 0x8000) {
    binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

/**
 * Writes the scene back in the format the file already had. `settings` was
 * measured off the file when it opened; the scene's appState does not carry it
 * (see export-settings.ts).
 */
const writeScene = async (
  filePath: string,
  format: SceneFormat,
  scene: any,
  elements: readonly any[],
  settings: ExportSettings,
): Promise<{ ok: boolean; error?: string }> => {
  const appState = scene.appState ?? {};
  const files = scene.files ?? {};

  if (format === "json") {
    return window.api.writeFile(
      filePath,
      serializeAsJSON(elements, appState, files, "local"),
    );
  }

  const exportAppState = {
    ...appState,
    // Without this the file stops being editable.
    exportEmbedScene: true,
    exportBackground: settings.background,
    exportWithDarkMode: settings.darkMode,
    exportScale: settings.scale,
  };

  if (format === "svg") {
    const svg = await exportToSvg({
      elements: elements as any,
      appState: exportAppState,
      files,
    });
    const markup = new XMLSerializer().serializeToString(svg);
    return window.api.writeFile(filePath, markup);
  }

  const blob = await exportToBlob({
    elements: elements as any,
    appState: exportAppState,
    files,
    mimeType: "image/png",
    // exportScale alone is ignored: without getDimensions the canvas is 1×.
    getDimensions: (width: number, height: number) => ({
      width: Math.trunc(width * settings.scale),
      height: Math.trunc(height * settings.scale),
      scale: settings.scale,
    }),
  });
  return window.api.writeFileBase64(filePath, await blobToBase64(blob));
};

const EMPTY_SCENE = {
  type: "excalidraw",
  version: 2,
  source: "excalidraw-desktop",
  elements: [],
  appState: {},
  files: {},
};

export default function App() {
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  /** Gates persistence: writing before the session is back would erase it. */
  const [hydrated, setHydrated] = useState(false);
  /** Files whose scene came up empty although the file has content. Never saved. */
  const [brokenScenes, setBrokenScenes] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [libraryItems, setLibraryItems] = useState<any[] | null>(null);
  const [libraryReturnUrl, setLibraryReturnUrl] = useState<string>();
  const libraryRef = useRef<any[]>([]);

  // onChange fires on every pointer move: bookkeeping stays in refs.
  const baseline = useRef(new Map<string, string>());
  /** Pre-filter: no version bump means no need to sign the scene. */
  const lastSeenVersion = useRef(new Map<string, number>());
  const dirtyTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** Latest scene per path: what a remount restores from, and what a save writes. */
  const sceneCache = useRef(new Map<string, any>());
  const apiRef = useRef<any>(null);
  const filesRef = useRef<OpenFile[]>([]);
  filesRef.current = files;
  const activeRef = useRef<string | null>(null);
  activeRef.current = activePath;
  const mountedAt = useRef(new Map<string, number>());
  const lastMounted = useRef<string | null>(null);
  /*
   * Files still owing their first-load pass: re-baseline plus the empty-scene
   * check. Once per open from disk, never per mount — a remount restores from
   * sceneCache, so unsaved edits would become the baseline and an emptied
   * drawing would look broken.
   */
  const pendingBaseline = useRef(new Set<string>());
  const loadedCount = useRef(new Map<string, number>());
  const exportSettings = useRef(new Map<string, ExportSettings>());
  /** One save per path, with at most one waiting behind it. */
  const saving = useRef(new Map<string, Promise<boolean>>());
  const queuedSave = useRef(new Map<string, Promise<boolean>>());
  /** Open or loading. `files` lags a render, which would open a path twice. */
  const openedPaths = useRef(new Set<string>());
  const restored = useRef(false);
  const queuedOpens = useRef<string[]>([]);
  const brokenRef = useRef<Set<string>>(new Set());
  brokenRef.current = brokenScenes;

  const setDirty = useCallback((path: string, dirty: boolean) => {
    setFiles((prev) => {
      const target = prev.find((f) => f.path === path);
      if (!target || target.dirty === dirty) {
        return prev; // no re-render on every stroke
      }
      return prev.map((f) => (f.path === path ? { ...f, dirty } : f));
    });
  }, []);

  const evaluateDirty = useCallback(
    (path: string) => {
      const timer = dirtyTimers.current.get(path);
      if (timer) {
        clearTimeout(timer);
        dirtyTimers.current.delete(path);
      }
      if (brokenRef.current.has(path)) {
        return;
      }
      const scene = sceneCache.current.get(path);
      if (!scene) {
        return;
      }
      const signature = sceneSignature(scene.elements ?? []);
      setDirty(path, signature !== baseline.current.get(path));
    },
    [setDirty],
  );

  /**
   * True when the file on disk matches the drawing, false when the write
   * failed. Anything about to discard the in-memory scene must check this.
   */
  const writeOnce = useCallback(
    async (path: string, force = false) => {
      if (brokenRef.current.has(path)) {
        return false;
      }
      evaluateDirty(path);
      const scene = sceneCache.current.get(path);
      if (!scene) {
        return false;
      }
      const elements = scene.elements ?? [];
      const signature = sceneSignature(elements);
      // ⌘S always writes: the signature can be quieter than reality.
      if (!force && signature === baseline.current.get(path)) {
        return true;
      }
      const format = formatOf(path);
      let res: { ok: boolean; error?: string };
      try {
        res = await writeScene(
          path,
          format,
          scene,
          elements,
          exportSettings.current.get(path) ?? DEFAULT_EXPORT_SETTINGS,
        );
      } catch (err: any) {
        res = { ok: false, error: String(err?.message ?? err) }; // export threw
      }
      if (!res.ok) {
        console.error("save failed", path, res.error);
        window.api.reportError?.(
          `${path}\n${res.error ?? ""}`,
          "Couldn't save the drawing",
        );
        return false;
      }
      dlog("saved", path);
      // The baseline is what was written, not what is on screen: an image
      // re-export runs for a while and anything drawn meanwhile is unsaved.
      baseline.current.set(path, signature);
      loadedCount.current.set(path, elements.length);
      setFiles((prev) =>
        prev.map((f) => (f.path === path ? { ...f, savedAt: Date.now() } : f)),
      );
      evaluateDirty(path);
      return true;
    },
    [evaluateDirty],
  );

  const startSave = useCallback(
    (path: string, force: boolean) => {
      const started = writeOnce(path, force).finally(() => {
        if (saving.current.get(path) === started) {
          saving.current.delete(path);
        }
      });
      saving.current.set(path, started);
      return started;
    },
    [writeOnce],
  );

  /** Never two writes at once for one file; the waiter picks up the latest scene. */
  const save = useCallback(
    (path: string, force = false): Promise<boolean> => {
      const running = saving.current.get(path);
      if (!running) {
        return startSave(path, force);
      }
      const waiting = queuedSave.current.get(path);
      if (waiting) {
        return waiting;
      }
      const next = running
        .catch(() => false)
        .then(() => {
          queuedSave.current.delete(path);
          return startSave(path, force);
        });
      queuedSave.current.set(path, next);
      return next;
    },
    [startSave],
  );

  /** The live answer; `dirty` only catches up DIRTY_CHECK_MS after an edit. */
  const isDirty = useCallback((path: string) => {
    if (brokenRef.current.has(path)) {
      return false;
    }
    const scene = sceneCache.current.get(path);
    if (!scene) {
      return false;
    }
    return sceneSignature(scene.elements ?? []) !== baseline.current.get(path);
  }, []);

  const saveAll = useCallback(async () => {
    let ok = true;
    for (const f of filesRef.current) {
      if ((f.dirty || isDirty(f.path)) && !(await save(f.path))) {
        ok = false;
      }
    }
    return ok;
  }, [isDirty, save]);

  const openPaths = useCallback(async (paths: string[], activate = true) => {
    const fresh = paths.filter((p) => !openedPaths.current.has(p));
    for (const p of fresh) {
      openedPaths.current.add(p);
    }
    const loaded: OpenFile[] = [];
    for (const p of fresh) {
      try {
        const format = formatOf(p);
        if (format !== "json") {
          const image = await dtime(`read ${p.split("/").pop()} (${format})`,
            () => readEmbeddedScene(p, format));
          const loadedImage = image.file;
          loaded.push(loadedImage);
          if (loadedImage.scene) {
            exportSettings.current.set(p, image.settings);
            sceneCache.current.set(p, loadedImage.scene);
            const els = loadedImage.scene.elements ?? [];
            loadedCount.current.set(p, els.length);
            baseline.current.set(p, sceneSignature(els));
            lastSeenVersion.current.set(p, getSceneVersion(els));
            pendingBaseline.current.add(p);
          }
          continue;
        }
        const r = await dtime(`read ${p.split("/").pop()}`, () =>
          window.api.readFile(p),
        );
        const info = { path: r.path, fileName: r.fileName, name: r.name, dir: r.dir };
        if (r.error || r.content === null) {
          loaded.push(errorTab(info, r.error ?? "This file can't be read."));
          continue;
        }
        let scene: any = EMPTY_SCENE;
        const parseStart = performance.now();
        try {
          scene = r.content.trim() ? JSON.parse(r.content) : EMPTY_SCENE;
        } catch {
          loaded.push(
            errorTab(
              info,
              "Couldn't parse the JSON — this doesn't look like an .excalidraw file.",
            ),
          );
          continue;
        }
        if (!isSceneJSON(scene)) {
          loaded.push(
            errorTab(
              info,
              "This JSON file isn't an Excalidraw scene, so there is nothing to " +
                "edit here. The file has been left alone.",
            ),
          );
          continue;
        }

        // Before Excalidraw sees it: bad ordering makes the canvas come up empty.
        const normalized = normalizeBoundText(scene);
        if (normalized.moved > 0) {
          dlog(`normalized ${r.name}`, {
            boundTextReordered: normalized.moved,
            note: "File left untouched. Saving with ⌘S after an edit writes the corrected order.",
          });
          scene = normalized.scene;
        }

        const els = scene.elements ?? [];
        dlog(`parsed ${r.name}`, {
          ms: Math.round(performance.now() - parseStart),
          bytes: r.content.length,
          elements: els.length,
          embeddedFiles: Object.keys(scene.files ?? {}).length,
          textElements: els.filter((e: any) => e.type === "text").length,
          fontFamilies: [
            ...new Set(
              els
                .filter((e: any) => e.type === "text")
                .map((e: any) => e.fontFamily),
            ),
          ],
        });
        loaded.push({
          path: r.path,
          fileName: r.fileName,
          name: r.name,
          dir: r.dir,
          scene,
          dirty: false,
          savedAt: null,
        });
        sceneCache.current.set(r.path, scene);
        loadedCount.current.set(r.path, els.length);
        // Provisional: re-taken once Excalidraw has repaired the scene.
        baseline.current.set(r.path, sceneSignature(els));
        lastSeenVersion.current.set(r.path, getSceneVersion(els));
        pendingBaseline.current.add(r.path);
      } catch (err: any) {
        // Per file: one bad one used to take the whole restored session down.
        const message = String(err?.message ?? err);
        dlog(`open failed ${p}`, message);
        console.error("open failed", p, err);
        loaded.push(errorTab(fileInfo(p), `Couldn't open this file: ${message}`));
      }
    }
    if (loaded.length) {
      setFiles((prev) => [...prev, ...loaded]);
    }
    if (activate && paths.length) {
      setActivePath(paths[paths.length - 1]);
    }
  }, []);

  const handleOpen = useCallback(async () => {
    const paths = await window.api.openDialog();
    if (paths.length) {
      await openPaths(paths);
    }
  }, [openPaths]);

  const handleNew = useCallback(async () => {
    const res = await window.api.newFileDialog([...openedPaths.current]);
    if (!res) {
      return; // cancelled
    }
    if (res.error || !res.path) {
      window.api.reportError?.(
        res.error ?? "The file could not be created.",
        "Couldn't create the drawing",
      );
      return;
    }
    await openPaths([res.path]);
  }, [openPaths]);

  const forget = (path: string) => {
    baseline.current.delete(path);
    lastSeenVersion.current.delete(path);
    sceneCache.current.delete(path);
    loadedCount.current.delete(path);
    mountedAt.current.delete(path);
    exportSettings.current.delete(path);
    pendingBaseline.current.delete(path);
    openedPaths.current.delete(path);
    const timer = dirtyTimers.current.get(path);
    if (timer) {
      clearTimeout(timer);
      dirtyTimers.current.delete(path);
    }
    // Or a file fixed in another app would still reopen as broken.
    setBrokenScenes((prev) => {
      if (!prev.has(path)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
  };

  /** Every per-file map is keyed by path; miss one on a rename and that file
   * loses its baseline or keeps writing to the old key. */
  const remapPath = useCallback((from: string, to: string) => {
    const maps: Map<string, any>[] = [
      baseline.current,
      lastSeenVersion.current,
      sceneCache.current,
      loadedCount.current,
      mountedAt.current,
      exportSettings.current,
    ];
    for (const m of maps) {
      if (m.has(from)) {
        m.set(to, m.get(from));
        m.delete(from);
      }
    }
    if (pendingBaseline.current.delete(from)) {
      pendingBaseline.current.add(to);
    }
    if (openedPaths.current.delete(from)) {
      openedPaths.current.add(to);
    }
    const timer = dirtyTimers.current.get(from);
    if (timer) {
      clearTimeout(timer);
      dirtyTimers.current.delete(from);
    }
    if (lastMounted.current === from) {
      lastMounted.current = to;
    }
    setBrokenScenes((prev) => {
      if (!prev.has(from)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(from);
      next.add(to);
      return next;
    });
  }, []);

  const handleRename = useCallback(
    async (path: string, nextBase: string) => {
      setRenaming(null);
      const file = filesRef.current.find((f) => f.path === path);
      if (!file || !nextBase.trim() || nextBase.trim() === file.name) {
        return;
      }
      const res = await window.api.renameFile(path, nextBase.trim());
      if (!res.ok || !res.path) {
        window.api.reportError?.(
          res.error ?? "The file could not be renamed.",
          "Couldn't rename the drawing",
        );
        return;
      }
      const nextPath = res.path;
      remapPath(path, nextPath);
      const fileName = nextPath.split("/").pop() ?? nextPath;
      setFiles((prev) =>
        prev.map((f) =>
          f.path === path
            ? { ...f, path: nextPath, fileName, name: displayName(fileName) }
            : f,
        ),
      );
      setActivePath((cur) => (cur === path ? nextPath : cur));
      dlog("renamed", `${path} -> ${nextPath}`);
    },
    [remapPath],
  );

  const handleTrash = useCallback(async (path: string) => {
    const file = filesRef.current.find((f) => f.path === path);
    const fileName = path.split("/").pop() ?? path;
    if (!(await window.api.confirmTrash(file?.name ?? fileName))) {
      return;
    }
    const res = await window.api.trashFile(path);
    if (!res.ok) {
      window.api.reportError?.(
        res.error ?? "The file could not be moved.",
        "Couldn't move the drawing to the Trash",
      );
      return;
    }
    dlog("trashed", path);
    forget(path);
    // No unsaved-changes prompt: there is nowhere left to save to.
    setFiles((prev) => {
      const next = prev.filter((f) => f.path !== path);
      if (activeRef.current === path) {
        const idx = prev.findIndex((f) => f.path === path);
        const fallback = next[idx] ?? next[idx - 1] ?? next[0] ?? null;
        setActivePath(fallback ? fallback.path : null);
      }
      return next;
    });
  }, []);

  const handleTabMenu = useCallback(
    async (path: string) => {
      setActivePath(path);
      const action = await window.api.tabMenu();
      if (action === "rename") {
        setRenaming(path);
      } else if (action === "reveal") {
        void window.api.revealInFinder(path);
      } else if (action === "trash") {
        void handleTrash(path);
      }
    },
    [handleTrash],
  );

  const handleClose = useCallback(
    async (path: string) => {
      if (isDirty(path)) {
        const file = filesRef.current.find((f) => f.path === path);
        const choice = await window.api.confirmDiscard(file?.name ?? path);
        if (choice === "cancel") {
          return;
        }
        // A failed save is already reported; keep the tab or its edits are gone.
        if (choice === "save" && !(await save(path, true))) {
          return;
        }
      }
      forget(path);
      setFiles((prev) => {
        const next = prev.filter((f) => f.path !== path);
        if (activeRef.current === path) {
          const idx = prev.findIndex((f) => f.path === path);
          const fallback = next[idx] ?? next[idx - 1] ?? next[0] ?? null;
          setActivePath(fallback ? fallback.path : null);
        }
        return next;
      });
    },
    [isDirty, save],
  );

  const handleSelect = useCallback((path: string) => {
    setActivePath(path); // unsaved work lives in sceneCache
  }, []);

  // `path` is bound at the render site, not read from the active tab: a late
  // change belongs to the canvas that produced it, not to the tab now showing.
  const onChange = useCallback(
    (path: string, elements: readonly any[], appState: any, sceneFiles: any) => {
      /*
       * Excalidraw keeps deleted elements around for undo. Written to the file
       * they would also leave the scene looking changed forever — an abandoned
       * empty text becomes an "unsaved" marker no undo clears.
       */
      const live = elements.filter((el) => !el.isDeleted);

      sceneCache.current.set(path, {
        elements: live,
        appState,
        files: sceneFiles,
      });

      const at = mountedAt.current.get(path);
      if (at !== undefined) {
        mountedAt.current.delete(path);
        dlog(`first onChange ${path.split("/").pop()}`, {
          ms: Math.round(performance.now() - at),
          elements: live.length,
          onDisk: loadedCount.current.get(path) ?? 0,
        });
      }

      if (pendingBaseline.current.has(path)) {
        pendingBaseline.current.delete(path);
        const expected = loadedCount.current.get(path) ?? 0;
        // Restored to nothing from a file with content: freeze it, since saving
        // would write that empty scene over the drawing.
        if (expected > 0 && live.length === 0) {
          dlog(`SCENE FAILED TO LOAD ${path}`, { expected });
          sceneCache.current.delete(path);
          setBrokenScenes((prev) => new Set(prev).add(path));
          return;
        }
        // Re-baseline: the repairs Excalidraw makes while loading are not edits.
        baseline.current.set(path, sceneSignature(live));
        lastSeenVersion.current.set(path, getSceneVersion(live));
        return;
      }

      if (brokenRef.current.has(path)) {
        return;
      }

      const version = getSceneVersion(live);
      if (lastSeenVersion.current.get(path) === version) {
        return;
      }
      lastSeenVersion.current.set(path, version);

      // A mutation is not yet a difference from disk; settle, then compare.
      if (!dirtyTimers.current.has(path)) {
        dirtyTimers.current.set(
          path,
          setTimeout(() => evaluateDirty(path), DIRTY_CHECK_MS),
        );
      }
    },
    [evaluateDirty],
  );

  /* ---------------- startup ---------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const flags = await window.api.getFlags();
      setDebugEnabled(flags.debug);
      // Without native vibrancy the glass has to paint its own ground.
      document.documentElement.dataset.vibrancy = flags.vibrancy ? "on" : "off";
      dlog("renderer boot");
      watchFonts();

      const [saved, returnUrl] = await Promise.all([
        window.api.getLibrary(),
        window.api.getLibraryReturnUrl(),
      ]);
      if (!cancelled) {
        libraryRef.current = saved ?? [];
        setLibraryItems(saved ?? []);
        setLibraryReturnUrl(returnUrl);
        dlog("library loaded", { items: (saved ?? []).length });
      }
      try {
        const stored = await window.api.getStore();
        if (cancelled) {
          return;
        }
        dlog("restoring session", stored.openPaths);
        setCollapsed(!!stored.sidebarCollapsed);
        applyGlass(stored.glass);
        if (stored.openPaths.length) {
          await openPaths(stored.openPaths, false);
          setActivePath(stored.activePath ?? stored.openPaths[0]);
        }
        if (!cancelled) {
          setHydrated(true);
          dlog("hydrated");
        }
      } catch (err: any) {
        // `hydrated` stays false: persisting now would erase the saved session.
        console.error("session restore failed", err);
        dlog("session restore FAILED — not persisting this session", String(err?.message ?? err));
      } finally {
        restored.current = true;
        // Last, so a double-clicked file wins the active tab over the session.
        const waiting = queuedOpens.current.splice(0);
        if (waiting.length && !cancelled) {
          dlog("opening files the OS handed over during startup", waiting);
          await openPaths(waiting);
        }
      }
    })();

    // Registering releases paths queued during startup.
    window.api.onOpenPath((p) => {
      if (restored.current) {
        void openPaths([p]);
      } else {
        queuedOpens.current.push(p);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [openPaths]);

  useEffect(() => {
    window.api.onMenu((command) => {
      if (command === "new") {
        void handleNew();
      } else if (command === "open") {
        void handleOpen();
      } else if (command === "save") {
        const p = activeRef.current;
        if (p) {
          void save(p, true);
        }
      } else if (command === "save-all") {
        void saveAll();
      } else if (command === "close") {
        const p = activeRef.current;
        if (p) {
          void handleClose(p);
        }
      } else if (command === "rename") {
        const p = activeRef.current;
        if (p) {
          setRenaming(p);
        }
      } else if (command === "trash") {
        const p = activeRef.current;
        if (p) {
          void handleTrash(p);
        }
      } else if (command === "toggle-sidebar") {
        setCollapsed((v) => !v);
      } else if (command.startsWith("glass:")) {
        applyGlass(command.slice("glass:".length));
      }
    });
  }, [handleNew, handleOpen, handleClose, handleTrash, save, saveAll]);

  // Capture phase: Excalidraw binds ⌘S to its own export, and this has to win.
  // ⌘1–9 jump between tabs.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Holding ⌘S would otherwise fire a fresh save every few milliseconds.
      if (!mod || e.repeat) {
        return;
      }
      if (!e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const p = activeRef.current;
        if (p) {
          void save(p, true);
        }
        return;
      }
      if (!e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const target = filesRef.current[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          e.stopImmediatePropagation();
          setActivePath(target.path);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [save]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    void window.api.setStore({
      openPaths: files.map((f) => f.path),
      activePath,
      sidebarCollapsed: collapsed,
    });
  }, [hydrated, files, activePath, collapsed]);

  useEffect(() => {
    window.api.setDirtyCount(files.filter((f) => f.dirty).length);
  }, [files]);

  // Raw .excalidrawlib text, fetched by the main process so the page CSP does
  // not have to allow the library host.
  useEffect(() => {
    window.api.onLibraryAdd(({ url, text }) => {
      const api = apiRef.current;
      if (!api) {
        return;
      }
      dlog("library install", url);
      void api
        .updateLibrary({
          libraryItems: new Blob([text], { type: "application/json" }),
          merge: true,
          openLibraryMenu: true,
          prompt: false,
        })
        .catch((err: any) => {
          console.error("library install failed", err);
          window.api.reportError?.(
            `${url}\n${err?.message ?? ""}`,
            "Couldn't add the library",
          );
        });
    });
  }, []);

  /*
   * Excalidraw opens any link it considers "local" in this window, and on
   * file:// that includes `https://anything/#file://` — which would hand that
   * page `window.api`. Element links stay in the canvas; the rest go to the
   * main process, which opens only http(s) and mailto.
   */
  const onLinkOpen = useCallback(
    (element: { link: string | null }, event: CustomEvent) => {
      event.preventDefault();
      const link = element.link ?? "";
      const api = apiRef.current;
      if (isElementLink(link)) {
        api?.scrollToContent(link, { fitToContent: true, animate: true });
        return;
      }
      void window.api.openLink(link).then((opened) => {
        if (!opened) {
          api?.setToast({
            message: `This link can't be opened: ${link}`,
            closable: true,
            duration: 4000,
          });
        }
      });
    },
    [],
  );

  const onLibraryChange = useCallback((items: readonly any[]) => {
    const copy = [...items];
    libraryRef.current = copy;
    void window.api.setLibrary(copy);
  }, []);

  useEffect(() => {
    window.api.onSaveAllRequest(async () => {
      window.api.saveAllDone(await saveAll());
    });
  }, [saveAll]);

  // Unsaved drawings live only in this renderer, so an unload would take them
  // with it. Cancelling makes the main process ask first.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (filesRef.current.some((f) => f.dirty || isDirty(f.path))) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  // A live count for the close prompt; the flags are debounced.
  useEffect(() => {
    window.api.onDirtyQuery((id) => {
      window.api.dirtyReply(
        id,
        filesRef.current.filter((f) => f.dirty || isDirty(f.path)).length,
      );
    });
  }, [isDirty]);

  const active = files.find((f) => f.path === activePath) ?? null;

  return (
    <div className={`exd-shell${collapsed ? " is-collapsed" : ""}`}>
      <Sidebar
        files={files}
        activePath={activePath}
        brokenScenes={brokenScenes}
        onSelect={handleSelect}
        onClose={handleClose}
        onNew={handleNew}
        onOpen={handleOpen}
        onCollapse={() => setCollapsed(true)}
        renaming={renaming}
        onStartRename={setRenaming}
        onRename={handleRename}
        onContextMenu={handleTabMenu}
      />
      {/* Takes over the traffic-light corner the sidebar was reserving. */}
      {collapsed && (
        <div className="exd-topbar">
          <button
            type="button"
            className="exd-glass-btn"
            onClick={() => setCollapsed(false)}
            title="Show Sidebar (⌘B)"
            aria-label="Show sidebar"
            aria-expanded="false"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="2" y="3" width="12" height="10" rx="2" />
              <path d="M6.5 3v10" />
            </svg>
          </button>
          {active && <span className="exd-topbar-title">{active.name}</span>}
        </div>
      )}
      <main className="exd-canvas-area">
        {!active ? (
          <div className="exd-empty">
            <h2>No drawing open</h2>
            <p>
              Double-click an .excalidraw file, or start here.
            </p>
            <div className="exd-empty-actions">
              <button className="exd-btn exd-btn-primary" onClick={handleNew}>
                New Drawing
              </button>
              <button className="exd-btn" onClick={handleOpen}>
                Open File
              </button>
            </div>
          </div>
        ) : brokenScenes.has(active.path) ? (
          <div className="exd-notice exd-notice-danger">
            <div>
              <h2>Couldn't load this drawing</h2>
              <p>
                <strong>{active.name}</strong> — the file has{" "}
                {loadedCount.current.get(active.path)} elements, but none of them
                made it onto the canvas.
              </p>
              <p>
                Saving is disabled for this file so the original can't be
                overwritten. Look for the <code>SCENE FAILED TO LOAD</code> line in
                the terminal log.
              </p>
            </div>
          </div>
        ) : active.error ? (
          <div className="exd-notice exd-notice-danger">
            <div>
              <h2>{active.name}</h2>
              <p>{active.error}</p>
            </div>
          </div>
        ) : (
          <div className="exd-canvas">
            {/* Keyed by path: one instance per file. Held back until the
                library is read, since initialData is only used on mount. */}
            {libraryItems !== null && (
            <Excalidraw
              key={active.path}
              excalidrawAPI={(api: any) => {
                apiRef.current = api;
                mountedAt.current.set(active.path, performance.now());
                dlog(`excalidrawAPI ready ${active.name}`);
                if (import.meta.env.DEV) {
                  (window as any).__exd = api;
                  // Lets the tests produce real .excalidraw.png/.svg fixtures.
                  (window as any).__exdExport = { exportToBlob, exportToSvg };
                }
              }}
              initialData={(() => {
                // Re-evaluated every render, read only on mount — so log once.
                if (lastMounted.current !== active.path) {
                  lastMounted.current = active.path;
                  dlog(`mounting canvas ${active.name}`);
                }
                const scene =
                  sceneCache.current.get(active.path) ?? active.scene ?? {};
                return {
                  elements: scene.elements ?? [],
                  appState: {
                    ...(scene.appState ?? {}),
                    collaborators: new Map(),
                  },
                  files: scene.files ?? {},
                  scrollToContent: true,
                  libraryItems: libraryRef.current,
                };
              })()}
              onChange={(elements: readonly any[], appState: any, files: any) =>
                onChange(active.path, elements, appState, files)
              }
              onLibraryChange={onLibraryChange}
              onLinkOpen={onLinkOpen}
              libraryReturnUrl={libraryReturnUrl}
              name={active.name}
            />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
