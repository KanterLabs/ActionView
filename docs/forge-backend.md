# Forge backend prerequisite

ActionView is a read-only client for a Forge dashboard. A release is useful
only when a user has a reachable, compatible Forge instance; the extension
does not ship a server, GitHub token, Kubernetes credential, or private
production URL.

The release includes a public-safe, read-only backend reference under
[`examples/forge-adapter/`](../examples/forge-adapter/). It reads real GitHub
Actions data and exposes the same API without requiring the private KanterLabs
infrastructure repository. The fuller dashboard implementation can still use
the following source path when an operator has access to that repository:

```text
homelab/ci-runners/dashboard/server.py
homelab/ci-runners/dashboard/workflow_metrics.py
homelab/ci-runners/dashboard/runner_improvements.py
```

The adapter README shows how to configure a read-only GitHub token, restrict
repositories, bind the service, and put it behind an HTTPS reverse proxy. It
is the usable public setup reference for this release. A fuller dashboard
deployment should likewise configure its state directory and upstream read
permissions, but must not publish a tailnet hostname, internal address,
credential, or private deployment fragment.

## Client contract

Set ActionView's **Base URL** to the HTTPS origin of that compatible Forge
instance. ActionView requests exactly:

```text
GET /api/operations
Accept: application/json
```

The response must be a JSON object with `schema_version: 5`, `generated_at`,
and `served_at`. The remaining operation fields are optional, but the server
should provide `sources`, `jobs`, `running_jobs`, `recent_runs`, `alerts`,
`cluster`, `host`, `history`, and `wait_stats` for the full dashboard. The
endpoint is read-only from the desktop and may return an `ETag`; ActionView
uses `If-None-Match` on subsequent polls.

The server should also expose `/healthz` for an operator's own reachability
check. The extension's **Test connection** button checks `/api/operations` and
reports the schema version and served time.

## Disposable verification endpoint

Release CI uses a loopback-only endpoint generated from committed, sanitized
fixtures. It contains no production hostname or credentials:

```sh
ci/test-artifact build/release --forge-e2e
```

That command starts `tools/forge-test-server.py` and records separate evidence
for a configured/reachable endpoint, an unsupported schema configuration, a
collector-hung fixture, a stale source fixture, an HTTP 503 offline response,
and a connection-refused endpoint after shutdown. This validates the
connection/configuration path against HTTP while the GNOME smoke hook validates
installation and in-shell rendering separately. Fixture mode alone does not
certify a reachable user backend.

For a real compatible endpoint, pass it explicitly and only for a disposable
or public-safe instance:

```sh
ci/test-artifact build/release --backend-url https://forge.example.invalid
```

The command has no default backend URL and never embeds a KanterLabs private
origin. Do not paste credentials into the URL or CI variables for package and
artifact-test jobs.
