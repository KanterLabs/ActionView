# Public Forge adapter reference

This directory is a small, self-contained backend reference for ActionView.
It reads real GitHub Actions data through the read-only REST API and emits the
same `GET /api/operations` contract consumed by the extension. It contains no
fixture data and does not implement workflow dispatch, rerun, cancellation,
or any other write operation.

The full KanterLabs Forge dashboard can provide richer host, Kubernetes,
capacity, and workflow metrics. This adapter is useful when a user needs a
publicly understandable setup path for the read-only client and has GitHub
Actions data but does not need those private homelab details.

## Run locally

Use a fine-grained GitHub token scoped to the selected repositories with
**Actions: read-only** and **Metadata: read-only** permissions. For public
repositories, the token can be omitted until the API rate limit requires one.
The adapter sends it only to the configured GitHub API origin as a bearer
header, never follows an upstream redirect, and never puts the token in an
ActionView URL or response.

```sh
export GITHUB_ORG=KanterLabs
export GITHUB_REPOS=KanterLabs/ActionView
export GITHUB_TOKEN='read-only-token'
export FORGE_BIND=127.0.0.1
export FORGE_PORT=8090
python3 examples/forge-adapter/server.py
```

Then set ActionView's Base URL to `http://127.0.0.1:8090` and press **Test
connection**. The adapter reports `schema_version: 5` and returns actual
workflow runs, active jobs, and organization runners. If an upstream request
fails, the response marks the GitHub source unavailable and includes a short
error; it does not turn missing data into an idle success.

For a shared or public deployment, bind behind an HTTPS reverse proxy and
configure an access policy appropriate for the selected repositories. Keep the
adapter's bind address private when the proxy is the only public entry point.
The production origin remains an operator setting; this repository embeds no
KanterLabs or homelab hostname.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | empty | Optional read-only token, sent as a bearer token |
| `GITHUB_ORG` | `KanterLabs` | Organization queried when repositories are omitted |
| `GITHUB_REPOS` | empty | Comma-separated `owner/repo` list to limit access and rate use |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub or compatible Enterprise API origin |
| `GITHUB_TIMEOUT_SECONDS` | `8` | Per-request upstream timeout |
| `FORGE_BIND` | `127.0.0.1` | Local listen address |
| `FORGE_PORT` | `8090` | Local listen port |
| `FORGE_CACHE_SECONDS` | `5` | Snapshot cache duration |

The endpoint is read-only. `GET /healthz` is a process check, `GET /readyz`
reports whether GitHub data was fetched, and `GET /api/operations` is the
ActionView data feed. Other routes and all POST requests are rejected.

The black-box test starts this adapter against a local HTTP server that emits
GitHub-shaped responses. Those responses exist only to make the test
repeatable; release and user deployments always fetch the configured GitHub
API.
