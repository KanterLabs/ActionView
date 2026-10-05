# ActionView — GNOME Shell extension for KanterLabs Forge

A top-bar indicator + dropdown that replaces "keep a browser tab open on
the Forge dashboard". Glanceable in the panel, one click to detail,
desktop notifications for the transitions you currently only catch by
refreshing the page, and — critically — an indicator you can *trust*: it is
loud when its data is stale or the server is unreachable.

## Status (2026-10-05)

**Shipped:** Phases 0 (repo side), 1 and 2 (client side). From phase 3, the
Quick Settings snooze toggle is done. Phase 4 has not started.

| Area | State |
|---|---|
| Core: normalize, diff state machine, connection, poll application (`apply.js`), badge, notification planning, snooze, URL validation | Done. 37 unit tests, green under `gjs` and `node`; 7 gjs-only `Poller` tests with a fake scheduler |
| Shell: client, poller, store + persistence, notifier, indicator + 7 sections, Quick Settings snooze toggle, prefs | Done. `make smoke` is green in a real headless gnome-shell 50.1 |
| Fixtures | `base.json` is captured live over ssh and sanitized (`tools/sanitize-fixture.py`: repos, titles, users and hosts are replaced with demo values; unused sections are dropped). There are 8 derived scenarios (`tools/make-fixtures.py`) |
| CI (`.github/workflows/ci.yml`) | `homelab` runs lint+unit; `homelab-heavy` runs the headless smoke. Green on GitHub (`main` push and PR runs). The smoke job needs a system bus plus a `python3-dbusmock` logind, because gnome-shell 50 crashes at startup without them |
| ETA per running job | **Deferred to phase 3** (see §4.8) |
| Server ETag/304, SSE, auth token | Not started (phase 4). The client already sends `If-None-Match` and handles 304. ETag alone is low value; see §7 |
| Local network loss | A failed poll while `Gio.NetworkMonitor` reports no network is "No network": offline badge, no unreachable/recovered notifications, fresh 3-failure grace once back. Polls immediately on network return and on resume from suspend |
| Network path for a remote desktop | **Solved with no infra change:** an existing Tailscale subnet route into the Forge LAN, which SNATs to an address Forge already allows. The client only needs `tailscale set --accept-routes` |

## 0. Ground truth (verified 2026-09-28)

**Server.** Forge is a single-file Python `ThreadingHTTPServer` in the private
infrastructure repo. The deployed copy can be newer than a given checkout, so
read the deployed one. It also emits `latency_stats` and
`cluster.platform_concurrency`, which ActionView ignores.

| Endpoint | Role |
|---|---|
| `GET /api/operations` | Primary feed: `schema_version, generated_at, served_at, sources, host, cluster, capacity, jobs, active_runs, recent_runs, runners, running_jobs, history, alerts, wait_stats` |
| `GET /api/workflows` | Workflow inventory + runner target per workflow (phase 3) |
| `GET /api/workflow-metrics?repository&workflow_path&job_id` | Per-job duration history → ETA (phase 2) |
| `GET /healthz`, `/readyz` | Prefs "Test connection" |
| `POST /api/control/*` | Needs OAuth session + CSRF — phase 4 only |

**Network.** Forge binds only its LAN address and firewalls its port to a
small allowlist, so tailnet addresses can't reach it directly. Remote clients
get in through a Tailscale subnet route into that LAN. The route SNATs to an
address that is already allowed, so the client needs
`tailscale set --accept-routes` and nothing else.

**Dev box.** Ubuntu 26.04. `gjs 1.88` and `gnome-shell 50.1` are now
installed (`--no-install-recommends`) for the headless loop. The system
`eslint` is v6, which is too old, so lint uses `npx eslint@10`.

## 1. Decisions

1. **Thin client of `/api/operations`.** No GitHub/k8s tokens on the desktop,
   no second GitHub-rate-limit consumer, one owner of reconciliation logic
   (`reconcile_running_jobs`, `compute_alerts`). The extension never derives
   anything the server already derives.
2. **`server.py` is in scope, but not for the MVP.** It is your code; small
   additive server changes (ETag/304, SSE) are cheaper than client heroics.
   Phase 1 requires zero server changes so the extension is useful immediately.
3. **Target GNOME 48–50** (ESM `Extension` class, Soup 3, 46+ MessageTray API,
   `-st-accent-color`, and `St.BoxLayout.orientation`, which is 48+). Plain
   GJS, no bundler.
4. **Honesty over polish.** Badge priority: unreachable > stale > critical
   alert > recent failure > queued > running > warning > idle. A wrong-but-green
   indicator is worse than the browser tab.
5. **Pure core.** Everything that decides *what changed* is Shell-free JS,
   unit-tested against captured payloads. UI is a dumb renderer of that state.

## 2. Why it beats the browser page

| Browser page | ActionView |
|---|---|
| Must be looking at the tab | Panel badge always visible, colour-coded by priority |
| No push signal | Notifications: failure, long queue, alert raised/cleared, server unreachable/recovered (start/success opt-in) |
| Duration refreshes only on reload | Local 1 s elapsed tick; queued wait compared against the repo's p95 (ETA deferred, §4.8) |
| Starting job listed twice (ARC "running" + GitHub "queued") | De-duplicated by job id / run+name |
| Every capacity row, incl. `cap 0–0` | Only scale sets with capacity or activity |
| 7-row sources table always | One line "all 7 fresh"; expands only on a problem |
| Rows inert | Click job → GitHub log; click repo → Actions page; notification actions "Open log" / "Mute repo" |
| Full re-render → flicker | Keyed in-place updates; hover/keyboard focus survives polls |
| Silent when the server dies | Badge goes grey with age of last good data; one notification, one on recovery |

## 3. UX

### Panel indicator
Symbolic icon + short label. States, in priority order:
- offline/stale: dimmed icon, label shows data age, e.g. `3m`
- critical alert: red
- unacknowledged failure: red `✕ 1`. **Opening the menu acknowledges it**,
  instead of the badge staying pinned for 1 h. The failure stays pinned at the
  top of Recent runs for 1 h.
- queued: amber `⏳ 2`
- running: accent colour, `▶ 1`
- warning
- idle: dimmed icon

The inline panel sparkline was dropped because the panel is too small for it
to be readable.

### Dropdown (~420 px)
1. **Header** — health dot · "updated 3 s ago" · hostname · refresh · open dashboard · settings.
2. **Alerts** — only when non-empty, severity-coloured.
3. **Running** — card per `running_jobs`: repo · job · short runner name ·
   elapsed / ETA · CPU/mem (server attaches pod metrics) · branch · actor.
4. **Queued** — job, wait so far (amber + "slower than p95" past the repo's
   p95), typical wait p50 in the heading, from `wait_stats`.
5. **Trends** — CPU %, Mem %, Load 1, Jobs sparklines from `history`
   (`St.DrawingArea` + Cairo, `accessible_name` set).
6. **Capacity** — bars for scale sets with `max > 0` or activity; current
   (green) + pending (amber).
7. **Recent runs** — last 8, conclusion glyph, relative time; failures pinned.
8. **Sources** — one line; per-source table when any is not fresh.

Optional later: a Quick Settings toggle "Forge notifications" (mute for the
afternoon without opening prefs).

## 4. Architecture

```
actionview@kanterlabs.dev/
  metadata.json                 shell-version 48, 49, 50
  extension.js                  enable(): Client, Store, Notifier, Poller, Indicator; disable(): stop poller → destroy indicator → persist
  prefs.js                      Adw: base/dashboard URL + Test connection, polling, panel position, notifications, muted repos
  stylesheet.css                palette mirrors the web page; -st-accent-color for running
  icons/actionview-symbolic.svg
  schemas/org.gnome.shell.extensions.actionview.gschema.xml
  lib/
    core/                       ← PURE (no gi://). Tested under gjs AND node.
      normalize.js              payload → view model; every field optional; never throws
      diff.js                   (state, view, now) → {state, events}  (§4.2)
      connection.js             failures/backoff/unreachable/recovered state machine
      badge.js                  view + state + connection → {level, label, summary}
      notifications.js          events + prefs → notifications; per-repo coalescing; rate limit
      format.js                 durations, bytes, cores, short runner names
      apply.js                  one poll result → next {view, state, conn} + events (Store's logic)
      snooze.js                 snooze end times and labels
      url.js                    base URL validation/normalization for prefs
    client.js                   Soup 3; If-None-Match/304; ACTIONVIEW_FIXTURE override; shared with prefs
    poller.js                   adaptive cadence (§4.3), single in-flight, Gio.Cancellable
    store.js                    owns view/state/conn/badge; emits 'changed' + 'events'; persists
    persist.js                  $XDG_CACHE_HOME/actionview/state.json
    notifier.js                 MessageTray.Source (recreated lazily); Open log / Mute repo actions
    util.js                     openUri, dashboardUrl
    ui/
      indicator.js              PanelMenu.Button; renders only while the menu is open (badge always)
      snoozeToggle.js           Quick Settings "Forge" toggle → snooze-until
      sections/  header banner jobs trends capacity recent sources
      widgets/   row (InfoRow) keyedList sparkline capacityBar
tests/
  core.test.js                  37 tests; `gjs -m` or `node`
  poller.test.js                7 tests; `gjs -m` only (fake scheduler)
  fixtures/operations/          base.json (live capture) + running, queued, concluded-{failure,success},
                                alert, source-stale, collector-hung, schema-future
tools/
  capture-fixture.sh            ssh to the Forge host → curl its own port → sanitize-fixture.py
  make-fixtures.py              derives scenarios from base.json (explicit, reviewable mutations)
  smoke.sh                      headless gnome-shell e2e (§6)
  smoke/actionview-smoke@…/     test-only driver extension (never installed on a desktop)
.github/workflows/ci.yml        lint+unit on `homelab`; headless smoke on `homelab-heavy`
```

### 4.1 Data flow
`Poller` → `Client.getJson()` → `Store.applySuccess|applyFailure` → `normalize()` →
`diff()` + `nextConnection()` → `computeBadge()` → `'changed'` (Indicator) and
`'events'` (Notifier → `planNotifications()` → `rateLimit()`). The badge is
computed from view + diff state + connection, never from UI state.

### 4.2 Diff state machine (the crux of trustworthy notifications)
Identities: running job `key` (server-provided, e.g. `arc:<runner>`), queued
job `job_id`, run `id`.
Persisted state (JSON, `STATE_VERSION` 2; v1 is migrated): `seenRuns {id → updatedAt}` (capped
at 300), `activeRuns[]`, `runningKeys[]`, `queuedNotified[]`, `alerts[]`
(normalized keys), `sourceBad {name → consecutive bad polls}`,
`unackedFailures[{id, repo}]` (repo so mutes can hide them), `savedAt`, `baselined`.

Events:
- `job.started`: a key appears in `running_jobs`. Notification is opt-in.
- `job.queued_long`: queued for at least `queued-alert-minutes`. Fires once per
  key and re-arms when the job leaves the queue.
- `run.concluded{failed}`: a *completed* run in `recent_runs` whose id we have
  never handled, or a re-run. A re-run is an id we saw active again whose
  `updated_at` changed; re-runs keep their id, so id-only dedup would miss them.
  This replaced the planned `awaitingConclusion` buffer: keying on
  `recent_runs` membership is immune to ARC-vs-GitHub lag by construction.
  Failure means `failure`, `timed_out` or `startup_failure`. A later success
  clears the unacknowledged failure.
- `alert.raised` / `alert.cleared`: keyed on the message with digits replaced
  by `#`. Otherwise "memory at 81.3%" → "81.9%" would re-raise the alert on
  every poll.
- `source.stale` / `source.fresh`: `stale`/`unavailable` on 2 consecutive
  polls. `partial` and `loading` are not treated as stale.
- `forge.unreachable` / `forge.recovered`: after 3 failures, and on the first
  success after that.

Cold start: persisted state younger than 1 h is resumed, so a failure that
happened while the screen was locked is still reported. Anything older, or no
state at all, starts a fresh baseline: the first poll emits nothing.

### 4.3 Polling
- Menu open, or any running/queued: **5 s** (matches the server's own 5 s sample).
- Idle: **30 s**. GitHub-derived fields only change every ~20–60 s anyway.
- Failure: 5 → 10 → 20 → 60 s backoff; `unreachable` after 3.
- Stale: `served_at − generated_at` > 90 s (collector hung), or a source
  confirmed bad (§4.2). Shown in the banner and badge.
- The client already sends `If-None-Match` and treats 304 as "fresh,
  unchanged". It becomes useful once the server emits ETags (phase 4).
- One in-flight request at a time; all requests share a `Gio.Cancellable`
  cancelled in `disable()`.
- Elapsed tick: one 1 s `GLib.timeout`, only while the menu is open. A closed
  menu is not re-rendered at all; only the badge updates.

### 4.4 Notifier
- One `MessageTray.Source`. Dedup key = event type + id. Coalesce events from
  the same poll per repo ("3 jobs failed in web-app") — matrix builds fail in bursts.
- Urgency: failure/critical → HIGH; queued-long/warning → NORMAL; success/start → LOW.
- Actions: **Open log** (`Gio.AppInfo.launch_default_for_uri`), **Mute repo**
  (appends to `muted-repos`). Muted repos still render in the menu, dimmed.
- Global rate limit 6/min; excess collapsed into one "N more events" notification.

### 4.5 UI rendering
`keyedList.js`: reconcile children by key — update existing actors, add/remove
only on diff. No full menu rebuilds while open. Sparklines redraw on `'changed'`
only if `history` length or last sample changed.

### 4.6 Settings (GSettings)
`base-url` ('' shows "Forge URL not set"), `dashboard-url` ('' = base),
`poll-active-seconds` 5 (2–60), `poll-idle-seconds` 30 (10–600),
`notify-failure` on, `notify-success` off, `notify-start` off, `notify-queued`
on, `queued-alert-minutes` 5, `notify-alerts` on, `muted-repos` [],
`panel-show-label` on, `panel-box` right. Prefs "Test connection" fetches
`/api/operations` and reports the schema version and `served_at`.

### 4.7 Contract with the server
- Gate on `schema_version`: anything other than 5 renders best-effort, with a
  banner row. Every field is optional, and `normalize()` never throws (tested
  against garbage input).
- Fixtures are captured from the live server via `tools/capture-fixture.sh`
  (ssh to the Forge host and curl its own address). Everything passes through `tools/sanitize-fixture.py`, which fails if any original identifier survives.
  Re-capture on every `SCHEMA_VERSION` bump.

### 4.8 Why ETA is deferred
`running_jobs[].job` is the matrix-expanded display name ("Building for Fedora
43"). `/api/workflow-metrics` is keyed by the workflow YAML job id (`publish`,
whose name is "Publishing ${{ matrix.build_target }}"). There is no reliable
client-side mapping between the two. The clean fix is server-side: attach
`duration_p50_seconds` to each running job in `_enrich_running_resource_data`,
since the server already matches names in `resource_metrics.normalize_job_name`.

## 5. Phases

**Phase 0 — prerequisites** ✅
- Network: no firewall change. A Tailscale subnet route into the Forge LAN,
  which SNATs to an already-allowed address, was verified from an off-LAN
  tailnet node. The client runs `tailscale set --accept-routes`.

**Phase 1 — MVP (read-only, no server changes)** ✅
Scaffold, gschema, prefs with URL + Test connection. Client/poller/store,
`normalize` + `badge`. Panel badge with priorities. Sections 1, 3, 4, 8 +
open dashboard. Fixtures + core tests. Headless smoke test.

**Phase 2 — the "better" part** ✅ client side. ETA was moved to phase 3
(§4.8). The server-side ETag was moved to phase 4, because the server lives in
a deploy repo where a push is a deploy.
`diff.js` + persist + notifier (coalesce, actions). Alerts, trends, capacity
(zero-cap hidden), recent runs. Keyed rendering.

**Phase 3 — drill-down** (not started)
Per-job ETA (needs the server-side p50 from §4.8). Per-job submenu with
duration history. Workflows submenu from `/api/workflows`. ~~Quick Settings mute
toggle~~ done as a snooze toggle (1 h / 4 h / until 09:00 tomorrow).

**Phase 4 — push and control (server + client)** (not started)
`ETag` on `/api/operations`. The client side is already done.
`GET /api/events` SSE (ThreadingHTTPServer already supports long-lived
connections) → drop polling while connected, fall back to polling on drop.
Read-only bearer token for access from outside the firewall allowlist. Controls
(re-run/dispatch) need a desktop auth story (device-flow OAuth or scoped
token) — decide only if wanted.

## 6. Dev loop & verification (as built)
- `make test`: core tests under `gjs -m` and `node`.
- `make lint`: `npx eslint@10`, flat config. The system eslint 6 is too old.
- `make smoke` (`tools/smoke.sh`) runs the following steps:
  1. Creates a throwaway `HOME`/`XDG_*`, so the real dconf is untouched.
  2. Packs the extension and installs the zip, which is what ships.
     `gnome-extensions install` compiles the schemas.
  3. Starts `gnome-shell --headless --wayland --virtual-monitor` inside
     `dbus-run-session`.
  4. A **test-only driver extension** feeds scenario fixtures through
     `ACTIONVIEW_FIXTURE`. It records the badge *before* opening the menu,
     because opening acknowledges failures. It then screenshots each state
     in-process with `Shell.Screenshot`; the D-Bus screenshot API is restricted
     to allow-listed callers. It also opens and screenshots the prefs window.
  5. The driver runs 20 disable/enable cycles, then asserts one indicator, a
     status-area entry, ≤ 1 pending poller source, and a live view.
  6. The script fails on any warning/error block whose stack frames mention
     ActionView. Unrelated shell noise (e.g. dash icon lookups in a bare theme)
     is ignored. The gate was checked against a synthetic log that contains the
     real bugs found below.
  7. All paths handed to the shell are absolute, because gnome-shell chdirs to
     `$HOME`. A relative output dir once made the driver die silently. I first
     misread that as a startup flake and added a retry, then removed it once
     the real cause was found.
- The smoke test found three real bugs, all fixed:
  - `disable()` nulled the poller before destroying the indicator, and the
    menu-close handler then crashed.
  - The panel can destroy the indicator before `disable()` runs (at shell
    shutdown).
  - The stale badge showed a meaningless `0s`.
- **Still to verify live:** run a real `homelab-heavy` job and watch
  running → notification → Open log. This needs the desktop on the allowlist.

## 7. Open questions
1. ~~Which machine runs GNOME?~~ A Fedora laptop (GNOME 49.9) on the tailnet. Installed; `forge 200` via the subnet route.
2. Notify on job start / success by default, or failures + long queue only? (Plan defaults: failures + queue + alerts.)
3. Is panel-side control (re-run/dispatch) wanted eventually, or read-only for good?
4. **Decided against for now (2026-10-05):**
   - *ETag on its own.* The payload embeds `served_at` and a 5 s history
     sample, so it changes on almost every active poll and a 304 would rarely
     happen. Only worth it together with SSE, or with an ETag computed over
     the payload minus `served_at`.
   - *Re-run from a notification.* Needs a credential on the desktop, which
     breaks "no tokens on your desktop", plus an authenticated control
     endpoint on Forge. "Open log" is one click from GitHub's re-run button.
   - *Client-only ETA.* Ship it together with the server's
     `duration_p50_seconds` (§4.8), not ahead of it.
