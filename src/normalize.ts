/*
 * Excalidraw requires bound text to sit immediately after its container: files
 * that break that order throw during restore and the canvas comes up empty,
 * which the next save would write over the real drawing. Only moves elements.
 */
export const normalizeBoundText = (scene: any) => {
  const elements: any[] = scene?.elements ?? [];
  if (elements.length === 0) {
    return { scene, moved: 0 };
  }

  const indexById = new Map<string, number>();
  elements.forEach((e, i) => indexById.set(e.id, i));

  const boundByContainer = new Map<string, string[]>();
  for (const el of elements) {
    if (el.type === "text" && el.containerId && indexById.has(el.containerId)) {
      const list = boundByContainer.get(el.containerId) ?? [];
      list.push(el.id);
      boundByContainer.set(el.containerId, list);
    }
  }
  if (boundByContainer.size === 0) {
    return { scene, moved: 0 };
  }

  let outOfPlace = 0;
  for (const [containerId, textIds] of boundByContainer) {
    const base = indexById.get(containerId)!;
    textIds.forEach((textId, offset) => {
      if (indexById.get(textId) !== base + 1 + offset) {
        outOfPlace++;
      }
    });
  }
  if (outOfPlace === 0) {
    return { scene, moved: 0 };
  }

  const boundIds = new Set(
    [...boundByContainer.values()].flatMap((ids) => ids),
  );
  const next: any[] = [];
  for (const el of elements) {
    if (boundIds.has(el.id)) {
      continue; // reinserted right after its container
    }
    next.push(el);
    for (const textId of boundByContainer.get(el.id) ?? []) {
      next.push(elements[indexById.get(textId)!]);
    }
  }

  if (next.length !== elements.length) {
    return { scene, moved: 0 }; // never hand back a scene missing elements
  }

  return { scene: { ...scene, elements: next }, moved: outOfPlace };
};
