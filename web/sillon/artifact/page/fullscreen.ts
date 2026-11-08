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

const visible = (el: HTMLElement) => el.offsetParent !== null;

/**
 * Wires the top bar's toggle and the map's exit button (shown in immersive
 * mode, where the top bar is hidden) to full screen. The toggle keeps its
 * label and says its state with aria-pressed; the exit button is a plain
 * action. `onChange` runs after every switch so the map can resize.
 */
export const installFullscreen = (
  toggleButton: HTMLButtonElement,
  exitButton: HTMLButtonElement,
  onChange: (mode: ScreenMode) => void,
) => {
  let mode: ScreenMode = null;

  const render = () => {
    const had = document.activeElement;
    document.body.classList.toggle("immersive", mode === "immersive");
    toggleButton.setAttribute("aria-pressed", String(mode !== null));
    toggleButton.title = mode ? "Exit full screen (F)" : "Full screen (F)";
    // Focus on a button the switch just hid goes to the one now shown.
    if (had === toggleButton || had === exitButton) {
      const next = [toggleButton, exitButton].find(visible);
      if (next && next !== had && !visible(had as HTMLElement)) next.focus();
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

  for (const b of [toggleButton, exitButton])
    b.addEventListener("click", () => void toggle());

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
