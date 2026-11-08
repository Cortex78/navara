/*
 * Full screen for the instrument. Desktop browsers grant real full screen
 * from a click; phones and some app views refuse it, so the same control
 * falls back to an immersive mode that hides the panel and lets the map
 * fill the frame. Either way Escape, the button or "F" brings it back.
 */

export type ScreenMode = "native" | "immersive" | null;

type FullscreenDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FullscreenEl = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

const doc = document as FullscreenDoc;
const nativeElement = () =>
  doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;

const requestNative = async (el: FullscreenEl) => {
  if (el.requestFullscreen) return el.requestFullscreen();
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  throw new Error("full screen is not available");
};

const exitNative = async () => {
  if (doc.exitFullscreen) return doc.exitFullscreen();
  return doc.webkitExitFullscreen?.();
};

/**
 * Wires `buttons` (the panel's and the map's) to toggle full screen.
 * `onChange` runs after every switch so the map can resize to its new box.
 */
export const installFullscreen = (
  buttons: HTMLButtonElement[],
  onChange: (mode: ScreenMode) => void,
) => {
  let mode: ScreenMode = null;

  const render = () => {
    document.body.classList.toggle("immersive", mode === "immersive");
    for (const b of buttons) {
      b.setAttribute("aria-pressed", String(mode !== null));
      b.title = mode ? "Exit full screen (F)" : "Full screen (F)";
      const label = b.querySelector<HTMLElement>("[data-label]");
      if (label) label.textContent = mode ? "Exit" : "Full screen";
    }
    onChange(mode);
  };

  const set = (next: ScreenMode) => {
    mode = next;
    render();
  };

  const toggle = async () => {
    if (mode === "native") {
      await exitNative().catch(() => {});
      return; // fullscreenchange renders
    }
    if (mode === "immersive") {
      set(null);
      return;
    }
    const enabled =
      doc.fullscreenEnabled !== false &&
      typeof (document.documentElement as FullscreenEl).requestFullscreen ===
        "function";
    if (enabled) {
      try {
        await requestNative(document.documentElement);
        return; // fullscreenchange renders
      } catch {
        // Refused by this view (an app frame, a phone): fall through.
      }
    }
    set("immersive");
  };

  const onNativeChange = () => {
    if (nativeElement()) set("native");
    else if (mode === "native") set(null);
  };
  document.addEventListener("fullscreenchange", onNativeChange);
  document.addEventListener("webkitfullscreenchange", onNativeChange);

  for (const b of buttons) b.addEventListener("click", () => void toggle());

  document.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement | null;
    const typing =
      target?.tagName === "INPUT" ||
      target?.tagName === "SELECT" ||
      target?.tagName === "TEXTAREA" ||
      target?.isContentEditable;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      void toggle();
    } else if (
      e.key === "Escape" &&
      mode === "immersive" &&
      // Escape first cancels a drawing in progress (outlineEditor).
      !document.body.classList.contains("tool-on")
    ) {
      set(null);
    }
  });

  render();
  return { toggle, mode: () => mode };
};
