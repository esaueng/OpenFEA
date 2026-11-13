import { Children, type ComponentProps, type ReactNode } from "react";
// eslint-disable-next-line no-restricted-imports -- this wrapper is the one sanctioned use of drei's Text.
import { Text } from "@react-three/drei";
import sceneLabelFontUrl from "../assets/fonts/ibm-plex-sans-latin-500-normal.woff";
import { configureTextBuilder } from "troika-three-text";
import { sceneLabelText } from "../sceneLabelText";

// Troika's worker-based typesetter rehydrates its code with new Function()
// inside a blob worker, which the production CSP (script-src 'self') forbids —
// the gizmo labels would suspend forever and hide the whole viewer behind the
// Suspense fallback. Typeset on the main thread instead.
configureTextBuilder({ useWorker: false });

/**
 * The face every in-scene label (load and support callouts, probes, dimensions,
 * snap rulers, the axis triad and the view cube) uses. Self-hosted and
 * precached; WOFF because troika 0.52 rejects WOFF2. Weight 500 because scene
 * labels render at ~9-12px.
 */
export const SCENE_LABEL_FONT_URL = sceneLabelFontUrl;

type SceneLabelTextProps = Omit<ComponentProps<typeof Text>, "font">;

/**
 * drei's <Text> with the bundled face and label text limited to the glyphs that
 * face covers. Without a `font`, or for any character the font lacks, troika
 * asks unicode-font-resolver, which fetches from cdn.jsdelivr.net at runtime —
 * a network request the local-first app must never make (and an uncaught
 * "Failed to fetch" offline). Use this instead of importing Text directly; the
 * ESLint config enforces that.
 */
export function SceneLabelText({ children, ...props }: SceneLabelTextProps) {
  // drei concatenates string/number children into one text and mounts the rest
  // (materials etc.) as scene children; sanitize the joined text once.
  // Children.toArray keys the remaining nodes.
  let text = "";
  const nodes: ReactNode[] = [];
  for (const child of Children.toArray(children)) {
    if (typeof child === "string" || typeof child === "number") text += String(child);
    else nodes.push(child);
  }
  return (
    <Text {...props} font={SCENE_LABEL_FONT_URL}>
      {sceneLabelText(text)}
      {nodes}
    </Text>
  );
}
