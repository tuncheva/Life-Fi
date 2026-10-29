// Theme override: "system" follows the OS, "light" / "dark" force one via
// <html data-theme>. Kept per browser (a projector laptop usually wants light).
export type Theme = "system" | "light" | "dark";
const KEY = "lifefi.theme";

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(t: Theme): void {
  try {
    if (t === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* private mode: still applies for this page */
  }
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  window.dispatchEvent(new Event("lifefi-theme"));
}

/** Runs before paint (inline in <head>) so a forced theme never flashes. */
export const THEME_BOOT = `try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;
