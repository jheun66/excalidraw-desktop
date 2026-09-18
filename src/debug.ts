/*
 * Timing log for slow scene loads: dev, or EXD_DEBUG=1 in a build. Lines go to
 * the terminal as well as DevTools.
 */
const t0 = performance.now();

let enabled = true;

export const setDebugEnabled = (value: boolean) => {
  enabled = value;
};

export const dlog = (stage: string, detail?: unknown) => {
  if (!enabled) {
    return;
  }
  const at = `+${Math.round(performance.now() - t0)}ms`;
  const line =
    detail === undefined
      ? `[exd ${at}] ${stage}`
      : `[exd ${at}] ${stage} — ${
          typeof detail === "string" ? detail : JSON.stringify(detail)
        }`;
  // eslint-disable-next-line no-console
  console.log(line);
  window.api.debugLog?.(line);
};

export const dtime = async <T,>(stage: string, fn: () => Promise<T>) => {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    dlog(stage, `${Math.round(performance.now() - start)}ms`);
  }
};

/** Fonts decode outside React, so a mounted canvas can still look stuck. */
export const watchFonts = () => {
  if (!enabled || !document.fonts) {
    return;
  }
  const start = performance.now();
  dlog("fonts.status", {
    total: document.fonts.size,
    loading: document.fonts.status,
  });
  void document.fonts.ready.then(() => {
    const families = new Set<string>();
    document.fonts.forEach((f) => families.add(f.family));
    dlog("fonts.ready", {
      after: `${Math.round(performance.now() - start)}ms`,
      count: document.fonts.size,
      families: [...families],
    });
  });
};
