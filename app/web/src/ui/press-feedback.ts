// Press feedback: add .pressed the instant a button is pressed, remove it on release/leave/cancel; CSS handles the color change.
//
// Why not CSS :active —— iOS Safari only applies :active to elements whose self or ancestor has a touch listener;
// all buttons here delegate clicks via the parent container, and `.btn-ghost` sets
// `-webkit-tap-highlight-color: transparent` (disabling the system tap highlight),
// so on mobile "tapped" looks identical to "not tapped". Here we explicitly toggle the class via pointer events for consistent cross-platform behavior.
export function wirePressFeedback(root: HTMLElement, holdMs = 500): void {
  let pressed: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    pressed?.classList.remove("pressed");
    pressed = null;
  };
  const press = (event: Event): void => {
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    const btn = target.closest("button") as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    release();
    pressed = btn;
    btn.classList.add("pressed");
    // Fallback: a pressed card may be replaced by a re-render (node vanishes, pointerup is missed), so self-extinguish on timeout.
    timer = setTimeout(release, holdMs);
  };
  root.addEventListener("pointerdown", press, true);
  root.addEventListener("pointerup", release, true);
  root.addEventListener("pointercancel", release, true);
  root.addEventListener("pointerleave", release, true);
}
