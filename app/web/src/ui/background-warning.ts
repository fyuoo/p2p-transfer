// Best-effort heads-up shown when the page is backgrounded during an active transfer.
//
// On real mobile OS the page is *suspended* on background (JS frozen, not just throttled),
// so a transfer truly pauses until the user returns — MessageChannel pumping cannot help there.
// We show a persistent banner synchronously at the visibilitychange moment so the user sees the
// warning before/while the OS suspends the tab. The banner hides itself when the page becomes visible again.
export function installBackgroundWarning(getActiveCount: () => number): void {
  if (typeof document === "undefined" || !document.body) return;
  const banner = document.createElement("div");
  banner.className = "bg-warn";
  banner.setAttribute("role", "alert");
  banner.textContent = "传输进行中，切到后台会暂停，请保持前台";
  banner.style.display = "none";
  document.body.appendChild(banner);
  const update = () => {
    const show = document.hidden && getActiveCount() > 0;
    banner.style.display = show ? "block" : "none";
  };
  document.addEventListener("visibilitychange", update);
}
