# Harklight web client

Read and answer your Harklight messages in the browser: the inbox, an open
message, answering (choices, your own reply, Seen and No comment), chat with
files, live updates, settings and sign out. It does what the Harklight iPhone
app does, in light and dark, at desktop, tablet and phone widths.

The client is a static site (Preact and TypeScript, built with Vite). It is
served from the hosted Harklight origin and talks to Harklight Server over one
same-origin WebSocket and a few file routes, using the browser sign-in cookie.
It holds no credentials of its own.

## Develop

```sh
npm ci
npm run dev        # http://127.0.0.1:5173/inbox against a local fake Server
npm test           # unit tests, including the relay session against the fake
npm run build      # static files in dist/
npm run test:e2e   # browser tests against the built site and the fake
```

`dev/fake-server.mjs` is a stand-in for Harklight Server's browser door, with
sample messages. It follows the browser messaging contract closely enough to
develop and test against; it is not a Server.

## Configuration

Every address is a path on the origin the page is served from. A deployment
serves `/app/config.json` to override any of them and to turn feature flags
on; see `docs/deploy.md`. Nothing in the build names a host.

## License

MIT
