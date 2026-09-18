const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  openDialog: () => ipcRenderer.invoke("dialog:open"),
  newFileDialog: (openPaths) => ipcRenderer.invoke("dialog:new", openPaths),
  readFile: (path) => ipcRenderer.invoke("file:read", path),
  readFileBase64: (path) => ipcRenderer.invoke("file:readBase64", path),
  writeFile: (path, content) => ipcRenderer.invoke("file:write", path, content),
  writeFileBase64: (path, base64) =>
    ipcRenderer.invoke("file:writeBase64", path, base64),
  revealInFinder: (path) => ipcRenderer.invoke("file:reveal", path),
  openLink: (url) => ipcRenderer.invoke("link:open", url),
  renameFile: (path, nextBase) =>
    ipcRenderer.invoke("file:rename", path, nextBase),
  trashFile: (path) => ipcRenderer.invoke("file:trash", path),
  confirmTrash: (name) => ipcRenderer.invoke("dialog:confirmTrash", name),
  tabMenu: () => ipcRenderer.invoke("menu:tab"),
  confirmDiscard: (name) => ipcRenderer.invoke("dialog:confirmDiscard", name),
  reportError: (message, title) =>
    ipcRenderer.invoke("dialog:error", message, title),
  getStore: () => ipcRenderer.invoke("store:get"),
  setStore: (value) => ipcRenderer.invoke("store:set", value),
  getFlags: () => ipcRenderer.invoke("app:flags"),
  getLibrary: () => ipcRenderer.invoke("library:get"),
  setLibrary: (items) => ipcRenderer.invoke("library:set", items),
  getLibraryReturnUrl: () => ipcRenderer.invoke("library:returnUrl"),
  onLibraryAdd: (cb) => {
    ipcRenderer.removeAllListeners("library:add");
    ipcRenderer.on("library:add", (_e, payload) => cb(payload));
  },
  debugLog: (line) => ipcRenderer.send("debug:log", line),
  setDirtyCount: (count) => ipcRenderer.send("dirty:count", count),
  dirtyReply: (id, count) => ipcRenderer.send("dirty:reply", id, count),
  onDirtyQuery: (cb) => {
    ipcRenderer.removeAllListeners("dirty:query");
    ipcRenderer.on("dirty:query", (_e, id) => cb(id));
  },
  saveAllDone: (ok) => ipcRenderer.send("save-all:done", ok === true),
  onSaveAllRequest: (cb) => {
    ipcRenderer.removeAllListeners("save-all:request");
    ipcRenderer.on("save-all:request", () => cb());
  },
  onOpenPath: (cb) => {
    ipcRenderer.removeAllListeners("open-path");
    ipcRenderer.on("open-path", (_e, path) => cb(path));
    // Also releases paths queued before the window was listening.
    ipcRenderer.send("renderer:ready");
  },
  onMenu: (cb) => {
    ipcRenderer.removeAllListeners("menu");
    ipcRenderer.on("menu", (_e, command) => cb(command));
  },
});
