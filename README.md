# Harklight web client

Read and answer your Harklight messages in the browser: the inbox, an open
message, answering (choices, your own reply, Seen and No comment), chat with
files, live updates, settings and sign out. It works in light and dark, at
desktop, tablet and phone widths.

The client is a static site (Preact and TypeScript, built with Vite). It is
served from the hosted Harklight origin and talks to Harklight Server through
client API v2 (protocol 0.2) on the same origin (`fetch` reads and writes, and one
`EventSource` change feed), using the browser sign-in cookie.
It holds no credentials of its own.

## Develop

```sh
npm ci
npm run dev        # http://127.0.0.1:5173/inbox against a local fake Server
npm test           # unit tests, including the v2 session against the fake
npm run build      # static files in dist/
npm run test:e2e   # browser tests against the built site and the fake
```

`dev/fake-server.mjs` is a stand-in for Harklight Server's client API v2, with
sample messages. It follows the API's field contract closely enough to develop
and test against; it is not a Server.

## Configuration

Every address is a path on the origin the page is served from. A deployment
serves `/app/config.json` to override any of them and to turn feature flags
on; see `docs/deploy.md`. Nothing in the build names a host.

## License

MIT
