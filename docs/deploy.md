# Deploying the web client

## What is deployed

Every green push to `main` produces a CI artifact named
`harklight-web-<commit>`: `harklight-web-<commit>.tar.gz` (the contents of
`dist/`) and its `.sha256`. The site is static. The tarball holds:

- `index.html`
- `assets/` (hashed file names; safe to cache for a long time)

## Where it goes

Everything belongs under `/app/` on the hosted origin, in a directory the web
client's deploy owns alone. Nothing else is written there, and the web client
deploy writes nowhere else:

| Path on the origin | Serves |
|---|---|
| `/app/index.html`, `/app/assets/*` | the unpacked tarball |
| `/app/config.json` | deployment configuration (below); not in the tarball |
| `/inbox`, `/settings` | `/app/index.html` |

`index.html` and `config.json` should not be cached (`Cache-Control:
no-cache`); `assets/*` can be cached as immutable.

A deploy unpacks the tarball into a new directory and switches `/app/` to it,
keeping `config.json`. Other deploys of the same origin must leave `/app/`
alone (for example, exclude it from any `rsync --delete`).

## Server paths the page uses

These go to Harklight Server, same origin, with the browser sign-in cookie:

| Path | Use |
|---|---|
| `GET /browser/relay?recipient=<uuid>` | WebSocket upgrade, no subprotocol |
| `POST /browser/v1?recipient=<uuid>` | `file_limits`, `discard_uploads` (JSON) |
| `POST /browser/v1/upload?recipient=<uuid>` | one raw file body, `application/octet-stream`, `Content-Length` equal to the file size, no multipart; up to the Server's published per-file cap |
| `GET /browser/v1/files/<upload id>` | file download |
| `POST /sign-out` | sign-out form (`confirm=sign_out`) |
| `GET /api/profile` | the account's display name, `{"display_name": ...}` (`accountInfoPath`) |

Pages it links to: `/devices`, `/components`, the hosted account page.

## `config.json`

A JSON object; every key is optional and falls back to the default in
`src/config.ts`. Values are paths on the same origin (or the account page URL).

| Key | Default |
|---|---|
| `relayPath` | `/browser/relay` |
| `filesPath` | `/browser/v1` |
| `signOutPath` | `/sign-out` |
| `sessionEndedPath` | `/devices` (a Server page that sends a signed-out browser to hosted sign-in) |
| `accountUrl` | `/account/` |
| `componentsPath` | `/components` |
| `devicesPath` | `/devices` |
| `accountInfoPath` | `/api/profile` |
| `flags.webClient` | `false`: customers see a short notice and the page opens no connection |
| `flags.attachments` | `false`: no attach control; files show name and size only |

While `flags.webClient` is off, a tester can turn the client on in their own
browser by opening `/inbox#preview` (and off again with `#preview-off`).
Turning it on for customers is the release.
