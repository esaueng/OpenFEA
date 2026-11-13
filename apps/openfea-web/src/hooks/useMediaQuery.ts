import { useCallback, useSyncExternalStore } from "react";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

function mediaQueryList(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(query);
}

/** Live match state of a CSS media query; false where matchMedia is unavailable (SSR, tests). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const list = mediaQueryList(query);
    if (!list) return () => undefined;
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => mediaQueryList(query)?.matches === true, () => false);
}
