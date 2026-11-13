# Harklight web client

This repository is the Harklight web client: the browser app where a signed-in
Harklight customer reads and answers their Harklight messages. It does what the
iPhone app does and nothing more: inbox, open a message, answer or reply
(including choices and Seen), chat with files, live updates, settings and sign
out. It talks to Harklight Server only through the browser messaging contract.

## How this project ships

This is the intended way the project works.

1. **Continuous delivery.** Fixes and finished work go onto the live site right
   away, without waiting for anyone's permission. Before shipping, run the tests
   and whatever smoke test or validation you judge necessary for the change. If
   a bug turns up after that, it comes back as a bug report and gets fixed the
   same way.
2. **Trunk-based development.** Work goes straight to `main`. Do not make
   feature branches. Keep each change small, integrated and releasable, and keep
   `main` green: if `main` breaks, fix it or revert the change before stacking
   more work on it.
3. **Feature flags for large work.** A large feature that takes many iterations
   still lands on `main` in small steps and ships behind a feature flag until it
   is ready for release. Deploy passing builds independently of whether a
   feature is turned on.

## Feature flag practice

- An unfinished feature's flag defaults to off. Off must stop the behavior
  itself, not only hide its controls.
- Test both states: the live settings with the flag off, and the intended next
  settings with it on.
- A flag never hides a build failure, a startup failure or a broken shared
  dependency. Fix those before treating a build as releasable.
- Flags are temporary. Once a feature is released, remove its flag and the
  conditional code it guarded.
- Do not build a flag service. A flag is plain configuration.

Background reading: [trunk-based development](https://trunkbaseddevelopment.com/)
and [feature toggles](https://martinfowler.com/articles/feature-toggles.html).

## Public repository

This repository is public. Keep machine names, user ids, account or person
identifiers, secrets, internal addresses and internal notes out of every file,
commit message and pull request. Every address and setting comes from
deployment configuration.

## Working in this repository

- Stack: Preact and TypeScript, built with Vite into static files. Keep it
  small; add a dependency only when the job needs it.
- `npm run build`, `npm test` and `npm run test:e2e` are the checks CI runs on
  every push to `main`. Run them before you push.
- `dev/fake-server.mjs` stands in for Harklight Server's browser door during
  development and tests. When the real door behaves differently, the real door
  and the browser messaging contract win; fix the fake to match.
- Configuration and feature flags live in `src/config.ts`. The deployment
  overrides them with `config.json`. Flags: `attachments` (chat files) stays off
  until the Server's browser file routes are live.
- The look follows the accepted Harklight design: dark is the harklight.net
  look, light is derived from it. Shared pieces (the reply card, the answered
  card, label colours) must match the iPhone app.
