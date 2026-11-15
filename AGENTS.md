# Harklight web client

This repository is the Harklight web client: the browser app where a signed-in
Harklight customer reads and answers their Harklight messages. It does what the
iPhone app does and nothing more: inbox, open a message, answer or reply
(including choices and Seen), chat with files, live updates, settings and sign
out. It talks to Harklight Server only through the browser messaging contract.

## How this project ships

`main` is the only long-lived branch. Every change lands on it through a pull
request, and every release is a tag on it.

Keep work moving. Don't hold work back for a review, a test or a proof unless
the next step would be hard to undo or would reach real users. Reviews and
tests run alongside the work, not in front of it.

### Main-based development

- Work on a short-lived branch cut from current `main`. Merge it back within a
  day or two through a pull request. If a change can't land that quickly, make
  it smaller, or land it behind a feature flag (below). Never keep work on a
  long-running branch.
- Keep `main` releasable at every commit. A pull request merges to `main` when
  its checks (`npm run build`, `npm test`, `npm run test:e2e`) show no failure
  that `main` doesn't already have. Don't hold it for review: independent
  review by someone who didn't write it runs alongside the work, and any
  finding gets fixed in a follow-up pull request.
- Rebase or merge `main` into your branch often, so it never drifts far.
- Delete the branch when it merges.
- Don't create release branches, candidate branches or notes branches.
- If `main` breaks, fixing it comes before any other work. Revert first when
  that's the fastest way back to green.

### Continuous delivery

Fixes and finished work go onto the live site once reviewed clean, without
waiting for anyone's permission. Before shipping, run the tests and whatever smoke test or
validation you judge necessary for the change. If a bug turns up after that, it
comes back as a bug report and gets fixed the same way.

Going live to customers reaches real users, so it counts as the release: a
`main` commit goes live to customers once its checks pass and every change in
it has had a clean independent review. That still needs no one's permission.
Anything that doesn't reach customers doesn't wait for review: a build whose
new behavior stays behind a default-off flag, test and preview deployments.

### Releases

Releases go through CI and need no human approval.

- CI builds and tests every pull request, every push to `main` and every tag.
  For a `main` commit or a tag it also packages the site as
  `harklight-web-<commit>.tar.gz` with its `.sha256` (`docs/deploy.md`).
- Every change in a release must have had a clean independent review before
  the release is tagged. Tag that `main` commit as `vMAJOR.MINOR.PATCH`. The
  deployment installs a commit's archive after checking its SHA-256. Don't ask
  for approval before tagging or deploying.
- Any green `main` commit whose changes have all been reviewed clean may go
  live to customers, tagged or not; that is how tested fixes go live right
  away. Tags mark releases. They don't gate deploys.
- Escalate only for a real problem: a failing check you can't fix, or a release
  that would break something people rely on.
- If a release is bad, ship a fix or revert it from `main` as the next release.
  Don't patch a deployment by hand.

### Large features behind a feature flag

A feature too big for one short-lived branch lands on `main` in small slices,
hidden behind a flag until it is ready.

- **Off by default.** A new flag ships off, so `main` and every release behave
  exactly as before until the flag is turned on. Off must stop the behavior
  itself, not only hide its controls.
- **Prefer one flag per feature.** A feature that seems to need many flags is
  usually better split into smaller features.
- **The old path keeps working.** While the flag is off, existing behavior must
  be unchanged and still covered by the checks. Test both the on and off states
  of anything the flag touches.
- **Recorded.** Every flag has an entry in
  [docs/feature-flags.md](docs/feature-flags.md): name, purpose, owner, the
  work item it belongs to, its default, its state in production, and the
  condition for removing it.
- **Turning it on.** Flags are plain configuration in `src/config.ts`, which
  the deployment overrides with `/app/config.json`. Turning a flag on for
  customers is a recorded change to the deployment's `config.json`; changing a
  flag's default in `src/config.ts` to on is its own small pull request.
  Either way the flag reaches customers, so every change behind it must have
  had a clean independent review first. Update the register either way.
- **Removal is part of the feature.** Once a flag has been on in production and
  the feature is accepted, delete the flag, the off path and its tests in a
  follow-up pull request, and remove its entry. The feature isn't done until
  its flag is gone.
- **Branch by abstraction** is the alternative when you're replacing an
  existing mechanism rather than adding a new one. Put the old implementation
  behind an interface, build the new one alongside it, switch over, then delete
  the old one.
- A flag never hides a build failure, a startup failure or a broken shared
  dependency. Fix those before treating a build as releasable.
- Flags are for unfinished features. Don't use them for per-user settings or
  permanent configuration, and don't build a flag service.

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
  every pull request, push to `main` and tag. Run them before you push.
- `dev/fake-server.mjs` stands in for Harklight Server's browser door during
  development and tests. When the real door behaves differently, the real door
  and the browser messaging contract win; fix the fake to match.
- Configuration and feature flags live in `src/config.ts`. The deployment
  overrides them with `/app/config.json` (`docs/deploy.md`). The flags, their
  owners and their removal conditions are in
  [docs/feature-flags.md](docs/feature-flags.md).
- The look follows the accepted Harklight design: dark is the harklight.net
  look, light is derived from it. Shared pieces (the reply card, the answered
  card, label colours) must match the iPhone app.
