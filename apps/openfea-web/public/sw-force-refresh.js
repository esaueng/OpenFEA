(() => {
  const refreshParam = "openfea-sw-refresh";
  // A service worker activates once per newly installed build. Use that
  // activation's timestamp instead of a hand-maintained release string so
  // every deploy moves already-open tabs onto the new precached app shell.
  // A frozen value leaves long-lived CAE sessions running old mesh/solver
  // code even after a corrected bundle has reached production.
  const refreshVersion = String(Date.now());

  self.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        // Navigations in this scope wait for activation to finish. Awaiting
        // them in activate.waitUntil therefore deadlocks the new app shell.
        // Listen for the actual lifecycle transition instead of guessing a delay.
        const worker = self.registration.active;
        const refreshClients = () => {
          if (worker && worker.state !== "activated") return;
          worker?.removeEventListener("statechange", refreshClients);
          windowClients.forEach((client) => {
            if (typeof client.navigate !== "function") return;
            let url;
            try {
              url = new URL(client.url);
            } catch {
              return;
            }
            if (url.origin !== self.location.origin) return;
            if (url.searchParams.get(refreshParam) === refreshVersion) return;
            url.searchParams.set(refreshParam, refreshVersion);
            try {
              void client.navigate(url.href).catch(() => {});
            } catch {
              // Navigation can fail if the tab closes during activation.
            }
          });
        };
        worker?.addEventListener("statechange", refreshClients);
        refreshClients();
      })()
    );
  });
})();
