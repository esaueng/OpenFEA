import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Coffee } from "lucide-react";

export const KOFI_URL = "https://ko-fi.com/esau";
export const GITHUB_URL = "https://github.com/esaueng/OpenFEA";
export const COFFEE_ANIMATION_DURATION_MS = 1800;
export const COFFEE_ANIMATION_REPLAY_DELAY_MS = { min: 18000, max: 45000 } as const;
const COFFEE_LINK_TEXT = "Buy me a coffee";

export function coffeeAnimationReplayDelayMs(randomValue = Math.random()) {
  const safeRandomValue = Number.isFinite(randomValue) ? randomValue : 0;
  const boundedRandomValue = Math.min(1, Math.max(0, safeRandomValue));
  const delayRange = COFFEE_ANIMATION_REPLAY_DELAY_MS.max - COFFEE_ANIMATION_REPLAY_DELAY_MS.min;
  return Math.round(COFFEE_ANIMATION_REPLAY_DELAY_MS.min + delayRange * boundedRandomValue);
}

/**
 * The animated "Buy me a coffee" link. It lived in the workspace status bar until
 * plan 035 increment 6; it now sits in the start-screen footer (and the Project menu).
 */
export function KofiLink() {
  const [coffeeAnimating, setCoffeeAnimating] = useState(false);
  const [coffeeAnimationRun, setCoffeeAnimationRun] = useState(0);
  const animationTimeoutRef = useRef(0);
  const replayTimeoutRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (prefersReducedCoffeeMotion()) return undefined;

    function scheduleCoffeeAnimation() {
      replayTimeoutRef.current = window.setTimeout(() => {
        runCoffeeAnimation();
        scheduleCoffeeAnimation();
      }, coffeeAnimationReplayDelayMs());
    }

    runCoffeeAnimation();
    scheduleCoffeeAnimation();

    return () => {
      window.clearTimeout(animationTimeoutRef.current);
      window.clearTimeout(replayTimeoutRef.current);
    };
  }, []);

  function prefersReducedCoffeeMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  }

  function runCoffeeAnimation() {
    if (typeof window === "undefined" || prefersReducedCoffeeMotion()) return;
    setCoffeeAnimationRun((run) => run + 1);
    setCoffeeAnimating(true);
    window.clearTimeout(animationTimeoutRef.current);
    animationTimeoutRef.current = window.setTimeout(() => setCoffeeAnimating(false), COFFEE_ANIMATION_DURATION_MS);
  }

  return (
    <a className={`donate-link${coffeeAnimating ? " coffee-animating" : ""}`} href={KOFI_URL} target="_blank" rel="noreferrer" title="Support OpenFEA on Ko-fi" onMouseEnter={runCoffeeAnimation}>
      <span className="coffee-mark" aria-hidden="true" key={`coffee-mark-${coffeeAnimationRun}`}>
        <span className="coffee-steam coffee-steam-one" />
        <span className="coffee-steam coffee-steam-two" />
        <Coffee size={13} aria-hidden="true" />
        <span className="coffee-sparkle" />
      </span>
      <span className="coffee-label" key={`coffee-label-${coffeeAnimationRun}`}>
        {COFFEE_LINK_TEXT.split("").map((letter, index) => (
          <span
            className={letter === " " ? "coffee-letter coffee-letter-space" : "coffee-letter"}
            key={`${letter}-${index}`}
            style={{ "--coffee-letter-index": index } as CSSProperties}
          >
            {letter}
          </span>
        ))}
      </span>
    </a>
  );
}
