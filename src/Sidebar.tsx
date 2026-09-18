import React, { useEffect, useMemo, useRef, useState } from "react";

import type { OpenFile } from "./types";

type Props = {
  files: OpenFile[];
  activePath: string | null;
  brokenScenes: Set<string>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onNew: () => void;
  onOpen: () => void;
  onCollapse: () => void;
  renaming: string | null;
  onStartRename: (path: string | null) => void;
  onRename: (path: string, nextBase: string) => void;
  onContextMenu: (path: string) => void;
};

/** Commits on Enter or blur, abandons on Escape — as Finder does. */
function RenameField({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    if (settled.current) {
      return;
    }
    settled.current = true;
    onCommit(value);
  };

  return (
    <input
      ref={ref}
      className="exd-rename"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          settled.current = true;
          onCancel();
        }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

export default function Sidebar({
  files,
  activePath,
  brokenScenes,
  onSelect,
  onClose,
  onNew,
  onOpen,
  onCollapse,
  renaming,
  onStartRename,
  onRename,
  onContextMenu,
}: Props) {
  /** Only shown when names collide: the file name, or the folder if those match too. */
  const subtitles = useMemo(() => {
    const byName = new Map<string, typeof files>();
    for (const f of files) {
      byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
    }
    const out = new Map<string, string>();
    for (const group of byName.values()) {
      if (group.length < 2) {
        continue;
      }
      const distinctFileNames = new Set(group.map((f) => f.fileName)).size > 1;
      for (const f of group) {
        out.set(f.path, distinctFileNames ? f.fileName : f.dir);
      }
    }
    return out;
  }, [files]);

  const dirtyCount = files.filter((f) => f.dirty).length;

  return (
    <aside className="exd-sidebar">
      {/* Window handle — see .exd-drag-strip in styles.css. */}
      <div className="exd-drag-strip" aria-hidden="true" />
      <header className="exd-sidebar-head">
        <h1 className="exd-sidebar-title">Drawings</h1>
        <div className="exd-sidebar-actions">
          <button
            type="button"
            className="exd-icon-btn"
            onClick={onCollapse}
            title="Hide Sidebar (⌘B)"
            aria-label="Hide sidebar"
            aria-expanded="true"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="2" y="3" width="12" height="10" rx="2" />
              <path d="M6.5 3v10" />
            </svg>
          </button>
          <span className="exd-sidebar-sep" aria-hidden="true" />
          <button
            type="button"
            className="exd-icon-btn"
            onClick={onOpen}
            title="Open File (⌘O)"
            aria-label="Open file"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.4a1 1 0 0 1 .78.38l.72.9h5.1A1.5 1.5 0 0 1 14 5.78V11.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
            </svg>
          </button>
          <button
            type="button"
            className="exd-icon-btn"
            onClick={onNew}
            title="New Drawing (⌘N)"
            aria-label="New drawing"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3.25v9.5M3.25 8h9.5" />
            </svg>
          </button>
        </div>
      </header>

      {files.length === 0 ? (
        <p className="exd-file-list-empty">No drawings open.</p>
      ) : (
        <ul className="exd-file-list">
          {files.map((f, i) => {
            const isActive = f.path === activePath;
            const isBroken = brokenScenes.has(f.path) || !!f.error;
            return (
              <li key={f.path}>
                <div
                  className={[
                    "exd-tab",
                    isActive ? "is-active" : "",
                    isBroken ? "is-broken" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onContextMenu(f.path);
                  }}
                >
                  <button
                    type="button"
                    className="exd-tab-main"
                    onClick={() => onSelect(f.path)}
                    onDoubleClick={() => onStartRename(f.path)}
                    aria-current={isActive ? "true" : undefined}
                    title={i < 9 ? `${f.path}  (⌘${i + 1})` : f.path}
                  >
                    {/* Its own column: the dot must not sit under the close button. */}
                    <span className="exd-tab-status" aria-hidden={!f.dirty}>
                      {isBroken ? (
                        <span className="exd-mark exd-mark-broken" />
                      ) : f.dirty ? (
                        <span className="exd-mark exd-mark-dirty" />
                      ) : null}
                    </span>
                    <span className="exd-tab-label">
                      {renaming === f.path ? (
                        <RenameField
                          initial={f.name}
                          onCommit={(v) => onRename(f.path, v)}
                          onCancel={() => onStartRename(null)}
                        />
                      ) : (
                        <span className="exd-tab-name">
                          {f.name}
                          {f.dirty && (
                            <span className="exd-sr-only"> — unsaved</span>
                          )}
                        </span>
                      )}
                      {renaming !== f.path && subtitles.has(f.path) && (
                        <span className="exd-tab-dir">
                          {subtitles.get(f.path)}
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="exd-tab-close"
                    onClick={() => onClose(f.path)}
                    title="Close (⌘W)"
                    aria-label={`Close ${f.name}`}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                    </svg>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="exd-sidebar-foot">
        {dirtyCount > 0 ? (
          <>
            <span className="exd-mark exd-mark-dirty" aria-hidden="true" />
            {dirtyCount} unsaved {dirtyCount === 1 ? "drawing" : "drawings"}
            <kbd>⌘S</kbd>
          </>
        ) : files.length > 0 ? (
          <span className="exd-foot-quiet">All saved</span>
        ) : null}
      </footer>
    </aside>
  );
}
