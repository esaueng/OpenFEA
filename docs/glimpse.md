# Glimpse integration

OpenFEA uses its own `GLIMPSE` service binding and fixed app entrypoint in [Glimpse](https://github.com/esaueng/glimpse). See the service's [setup](https://github.com/esaueng/glimpse/blob/main/docs/SETUP.md) and [privacy/consent review](https://github.com/esaueng/glimpse/blob/main/docs/PRIVACY.md).

## Collection and controls

Basic statistics count backend API requests, HTTP 5xx failures and response time buckets. They exclude health probes, static assets and the optional-analytics relay. No browser Basic ping is added. Since exports and solves run locally, those appear only under Optional analytics; backend API totals are not visitor counts.

Optional analytics default off. Consent is an explicit checkbox at **Storage in the toolbar → Optional usage analytics**. The choice is per browser and app origin, never synced to an account or across apps. The new versioned `granted-v2` preference is not a visitor identifier. Older default-on analytics choices do not grant Glimpse consent. Withdrawal stops future sends immediately, aborts pending requests, and follows cross-tab storage changes. DNT/GPC suppress collection. Already received aggregates cannot be attributed or removed; no per-person history exists. If browser storage blocks withdrawal, the current page stops collection and explains how to clear the older saved grant.

The browser sends exactly `event` and a fixed `bucket`, omitting credentials and referrer. The Worker relay accepts only same-origin, bounded POST JSON, rejects extra keys, and forwards a freshly constructed metric over the app's service binding. Glimpse immediately increments daily aggregate counters; it has no raw event store. Neither payload contains model contents, geometry, filenames, project names, emails, URLs, error text/stacks, IP, user agent, accounts, sessions, device or visitor identifiers. Feature actions and workflow steps are independent counts, not individual sequences. Backend and optional levels stay separate. Optional totals represent **opted-in users only**.

`worker/glimpse.ts` is the relay/backend allowlist; `src/analytics.ts` is the client. Fixed durations are `<100 ms`, `100 ms–1 s`, `1–10 s`, `10–60 s`, `≥60 s`; exact timings are never sent. A constant app-wide rate-limit key bounds optional ingress without fingerprinting/IP keys. This can drop valid events and cannot prevent a custom client from spoofing allowed counts. Metrics are best effort, not billing or business records.

## Configuration and rollout

The checked-in `GLIMPSE_BASIC_ENABLED` and `GLIMPSE_USAGE_ENABLED` flags both start as `false`. The two switches are independent; the Optional switch additionally requires the browser's explicit opt-in. Missing/unavailable collectors do not affect app operations. Self-hosted/static configurations stay unconfigured unless deliberately connected to a separately protected service.

Deploy and configure the Glimpse Worker/D1/Access application first; then deploy this integration with its service binding. Confirm the intended audience, jurisdictions, lawful basis where relevant, notices and metadata retention before enabling Basic. Optional remains opt-in even if a jurisdiction offers an analytics exemption. Cookieless does not automatically mean consent-free. Edge/Access/existing app security logs still need separate review: the network necessarily processes IP and headers, although analytics stores neither. Dashboard authentication uses its own Access identity/cookies, not analytics identifiers.

Production deployment and remote migrations require separate authorization. No production resources, consent decisions or settings were changed by this PR. Roll back by setting both deployment switches to false and redeploying; users may withdraw independently through the same UI.

## Validation

Regression tests cover new-browser/legacy defaults, explicit opt-in, payload minimization, no cookies/referrer, immediate and cross-tab withdrawal, blocked storage, DNT/GPC, strict relay validation, streamed-body size enforcement, rate limits, kill switches and failure isolation. See the PR for the exact commands/results and any browser/CI limitations. Local tests and synthetic dashboard data do not prove production delivery, Access configuration or consent compliance for the eventual deployment.


## Expanded diagnostics (v2)

The updated notice requires a fresh browser choice; `granted-v1` is no longer a
valid grant. All expanded statistics require opt-in. Fixed diagnostic codes,
feature categories, size/part ranges and operation timing buckets are validated
by the mirrored `glimpseContract.ts` vocabulary in the client, relay and service.
Raw errors, stacks, names, content, geometry and identifiers are never forwarded.
Report counters live only in the current opted-in page, without time/order/IDs.
Withdrawal clears them and aborts sends. The user may explicitly download a
bounded JSON report, review it, then share it themselves. No automatic upload.
The Glimpse owner can inspect a strict report locally, using a file or pasted JSON.

The complete [measurement definitions and limits](https://github.com/esaueng/glimpse/blob/codex/diagnostics-overhaul/docs/EXPANDED-ANALYTICS.md)
explain repeatable observations versus account/project stocks and the consent
review. Size observations are not unique projects, parts are not a per-part
inventory, and diagnostic signals are not distinct bugs. No unique anonymous
user count or cross-app identity exists. Delivery is best effort and can drop
counts; reports' page-local counts need not equal delivered service counts.

OpenFEA has no registered cloud-account system or server-side project inventory.
Do not manufacture cloud accounts or storage totals from encrypted backup tokens.
Local project-file saves supply coarse file-size/body-count observations; encrypted
backup uploads/downloads supply transfer-size observations. Repeated operations
count again. Meshing/solver/export/import failures have fixed categories without
raw messages. DNT/GPC suppresses browser sends while retaining a visible stored
grant that the user can revoke. No new app database/migration is required; deploy
the expanded Glimpse service before enabling this app's optional collection.

Local v2 verification: five package builds and 269 package tests passed;
Cloudflare config, typecheck, 1,520 root tests, production build and bundle
budgets passed. Final focused analytics/relay/storage checks: 31 passed. Isolated
real-Chrome STEP-selection and project-results probes passed after permitting
the browser test process to bind its local debugging port. Hosted checks and
production event delivery are separate; collection flags remain off.
