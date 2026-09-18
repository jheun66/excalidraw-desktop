/*
 * Content signature for "does this scene still match what we loaded?".
 *
 * Excalidraw bumps element versions while restoring a scene, and it recomputes
 * text boxes and bound arrow paths as fonts load and bindings settle. Undo does
 * not restore those recomputed numbers, so signing them would leave a file
 * permanently "unsaved" after any move-then-undo. Both kinds are left out; what
 * remains is what the user authored.
 */
const VOLATILE = new Set(["version", "versionNonce", "updated"]);

const derivedFields = (el: any): readonly string[] => {
  if (el.type === "text") {
    if (el.containerId) {
      return BOUND_TEXT_DERIVED;
    }
    if (el.autoResize !== false) {
      return TEXT_DERIVED;
    }
  }
  if (
    (el.type === "arrow" || el.type === "line") &&
    (el.startBinding || el.endBinding)
  ) {
    return BOUND_LINEAR_DERIVED;
  }
  return EMPTY;
};

const TEXT_DERIVED = ["width", "height"] as const;
const BOUND_TEXT_DERIVED = ["width", "height", "x", "y"] as const;
const BOUND_LINEAR_DERIVED = [
  "x",
  "y",
  "width",
  "height",
  "points",
  "lastCommittedPoint",
] as const;
const EMPTY = [] as const;

/** `boundElements` is a set Excalidraw rebuilds in binding order, so sort it. */
const stableValue = (key: string, value: unknown) => {
  if (key === "boundElements" && Array.isArray(value)) {
    return [...value].sort((a, b) =>
      String(a?.id).localeCompare(String(b?.id)),
    );
  }
  return value;
};

export const sceneSignature = (elements: readonly any[]): string => {
  let hash = 0x811c9dc5;
  let length = 0;
  for (const el of elements) {
    const skip = derivedFields(el);
    // Top-level keys only: a JSON.stringify replacer would strip these names
    // out of nested objects too. Sorted so key order cannot shift the result.
    let s = "";
    for (const key of Object.keys(el).sort()) {
      if (VOLATILE.has(key) || skip.includes(key)) {
        continue;
      }
      s += `${key}:${JSON.stringify(stableValue(key, el[key]))};`;
    }
    length += s.length;
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `${elements.length}:${length}:${(hash >>> 0).toString(36)}`;
};
