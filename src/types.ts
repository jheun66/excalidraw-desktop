export type OpenFile = {
  path: string;
  name: string;
  fileName: string;
  dir: string;
  /** null for a file that could not be opened; `error` says why. */
  scene: any | null;
  error?: string;
  /** Lags an edit by DIRTY_CHECK_MS — see isDirty() for the live answer. */
  dirty: boolean;
  savedAt: number | null;
};

export type FileReadResult = {
  path: string;
  name: string;
  fileName: string;
  dir: string;
  content: string | null;
  error?: string;
};

declare global {
  interface Window {
    api: {
      openDialog: () => Promise<string[]>;
      /** null when cancelled. `openPaths` lets it refuse a file that is open. */
      newFileDialog: (
        openPaths: string[],
      ) => Promise<{ path?: string; error?: string } | null>;
      readFile: (path: string) => Promise<FileReadResult>;
      readFileBase64: (
        path: string,
      ) => Promise<{ base64: string | null; error?: string }>;
      writeFile: (
        path: string,
        content: string,
      ) => Promise<{ ok: boolean; error?: string }>;
      writeFileBase64: (
        path: string,
        base64: string,
      ) => Promise<{ ok: boolean; error?: string }>;
      revealInFinder: (path: string) => Promise<void>;
      /** false for anything that is not http(s) or mailto. */
      openLink: (url: string) => Promise<boolean>;
      renameFile: (
        path: string,
        nextBase: string,
      ) => Promise<{ ok: boolean; path?: string; error?: string }>;
      trashFile: (path: string) => Promise<{ ok: boolean; error?: string }>;
      confirmTrash: (name: string) => Promise<boolean>;
      tabMenu: () => Promise<"rename" | "reveal" | "trash" | null>;
      confirmDiscard: (name: string) => Promise<"save" | "discard" | "cancel">;
      reportError?: (message: string, title?: string) => Promise<void>;
      getStore: () => Promise<{
        openPaths: string[];
        activePath: string | null;
        sidebarCollapsed: boolean;
        glass: "clear" | "default" | "frosted";
      }>;
      setStore: (value: {
        openPaths: string[];
        activePath: string | null;
        sidebarCollapsed: boolean;
      }) => Promise<void>;
      getFlags: () => Promise<{ debug: boolean; vibrancy: boolean }>;
      getLibrary: () => Promise<any[]>;
      setLibrary: (items: any[]) => Promise<void>;
      getLibraryReturnUrl: () => Promise<string>;
      onLibraryAdd: (cb: (payload: { url: string; text: string }) => void) => void;
      debugLog?: (line: string) => void;
      setDirtyCount: (count: number) => void;
      /** Closing asks this for a live count, since `dirty` lags; reply with dirtyReply. */
      onDirtyQuery: (cb: (id: number) => void) => void;
      dirtyReply: (id: number, count: number) => void;
      /** The window closes only when `ok` is true. */
      saveAllDone: (ok: boolean) => void;
      onSaveAllRequest: (cb: () => void | Promise<void>) => void;
      onOpenPath: (cb: (path: string) => void) => void;
      onMenu: (cb: (command: string) => void) => void;
    };
  }
}
