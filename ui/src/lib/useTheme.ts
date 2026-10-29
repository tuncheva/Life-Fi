"use client";
import { useSyncExternalStore } from "react";
import { getTheme, type Theme } from "./theme";

function subscribe(cb: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  window.addEventListener("lifefi-theme", cb);
  mq.addEventListener("change", cb);
  return () => {
    window.removeEventListener("lifefi-theme", cb);
    mq.removeEventListener("change", cb);
  };
}

/** The user's choice: system / light / dark. */
export function useThemeChoice(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => "system");
}

/** What is on screen now, for canvases that need concrete colours. */
export function useResolvedTheme(): "light" | "dark" {
  return useSyncExternalStore(
    subscribe,
    () => {
      const forced = document.documentElement.getAttribute("data-theme");
      if (forced === "light" || forced === "dark") return forced;
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    },
    () => "light",
  );
}

/** Reads a design token (e.g. "--present") as a concrete colour for canvas drawing. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}
