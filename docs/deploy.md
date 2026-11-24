# Deploying the web client

## What is deployed

Every green push to `main`, and every release tag `vMAJOR.MINOR.PATCH`,
produces a CI artifact named
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

These go to Harklight Server, same origin, with the browser sign-in cookie. A
signed-out browser must get `401` JSON on `/v2`, never a redirect. The origin
must serve `/v2` over HTTP/2, so one feed per open tab never runs into the
browser's per-origin connection limit, and any proxy on the feed path must not
buffer or compress `text/event-stream` and must keep a read timeout above the
feed's 25 s heartbeat.

| Path | Use |
|---|---|
| `GET /v2/inbox`, `GET /v2/items/<id>`, `GET /v2/items/<id>/entries` | inbox and conversation reads |
| `GET /v2/changes?after=<rev>` | the change feed: one `EventSource` (`text/event-stream`), and the JSON batch form after a feed fails |
| `GET /v2/me` | file limits and the published answer-screen limits |
| `POST /v2/items/<id>/seen`, `/answer`, `/replies`; `PUT /v2/items/<id>/read-position` | the person's actions, each with an `Idempotency-Key` |
| `POST /v2/files` | one raw file body with its `Content-Type`, `Content-Length` and `Content-Disposition: attachment; filename*=UTF-8''<name>` |
| `GET /v2/files/<file id>` | file download |
| `POST /sign-out` | sign-out form (`confirm=sign_out`) |
| `GET /api/profile` | the account's display name, `{"display_name": ...}` (`accountInfoPath`) |

Pages it links to: `/devices`, `/components`, the hosted account page.

## `config.json`

A JSON object; every key is optional and falls back to the default in
`src/config.ts`. Values are paths on the same origin (or the account page URL).
An empty `accountUrl`, `devicesPath`, `componentsPath` or `signOutPath` hides
the control that leads there.

| Key | Default |
|---|---|
| `apiPath` | `/v2` (Harklight client API v2) |
| `signOutPath` | `/sign-out` |
| `sessionEndedPath` | `/devices` (a Server page that sends a signed-out browser to hosted sign-in) |
| `accountUrl` | `/account/` |
| `componentsPath` | `/components` |
| `devicesPath` | `/devices` |
| `accountInfoPath` | `/api/profile` |
| `flags.webClient` | `false`: customers see a short "Web messaging is coming soon" note linking to `devicesPath`, and the page opens no connection |
| `flags.answerForms` | `false`: custom answer forms (attention-client.ui/1) offer the plain Reply and No comment, and say the custom screen is not shown |
| `flags.attachments` | `false`: no attach control; files show name and size only |
| `flags.fyiInbox` | `true`: FYIs are grouped into an Inbox summary and a full list; `false` lists them as ordinary messages |

A tester can turn every feature on in their own browser only, whatever the
deployment's flags, by opening `/inbox#preview` (and off again with
`#preview-off`). Customers keep the deployment's settings.
Turning it on for customers is the release.
