import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test, vi } from "vitest";

const source = readFileSync(new URL("../../public/sw-force-refresh.js", import.meta.url), "utf8");

describe("service-worker forced refresh lifecycle", () => {
  test("finishes activation before starting a navigation that waits for activation", async () => {
    const listeners = new Set<() => void>();
    const worker = {
      state: "activating",
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener)
    };
    // This is deliberately unresolved: Chromium gates same-scope navigation
    // on activation. activate.waitUntil must never depend on this promise.
    const navigate = vi.fn(() => new Promise<void>(() => {}));
    let activate!: (event: { waitUntil: (promise: Promise<void>) => void }) => void;
    runInNewContext(source, {
      URL, Date: { now: () => 123 },
      self: {
        location: { origin: "https://example.test" },
        registration: { active: worker },
        clients: { matchAll: async () => [
          { url: "https://example.test/?project=qa", navigate },
          { url: "https://example.test/?openfea-sw-refresh=123", navigate },
          { url: "https://other.test/", navigate }
        ] },
        addEventListener: (_: string, listener: typeof activate) => { activate = listener; }
      }
    });
    let lifetime!: Promise<void>;
    activate({ waitUntil: (promise) => { lifetime = promise; } });
    await lifetime;
    expect(navigate).not.toHaveBeenCalled();
    worker.state = "activated";
    for (const listener of listeners) listener();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("https://example.test/?project=qa&openfea-sw-refresh=123");
    expect(listeners.size).toBe(0);
  });
});
