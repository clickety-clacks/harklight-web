# Feature flags

Flags that hide unfinished features. See the feature-flag rules in
[AGENTS.md](../AGENTS.md). Add a row when you add a flag, update it when its
default or its production state changes, and delete the row in the pull request
that removes the flag.

Flags live in `src/config.ts`. The deployment overrides them with
`/app/config.json` (`docs/deploy.md`).

| Flag | Purpose | Owner | Work item | Default | In production | Remove when |
| --- | --- | --- | --- | --- | --- | --- |
| `webClient` | Customers can use web messaging. Off shows the "coming soon" page, and no connection to the Server opens. | Harklight web delivery owner | `wi_cf6ed278` | off | off | It has been on for customers and the web client is accepted. Then delete the flag and the "coming soon" page. |
| `answerForms` | Draws custom answer forms. Off offers No comment and points to the iPhone app. | Harklight web delivery owner | `wi_cf6ed278` | off | off | It has been on for customers and custom forms are accepted. Then delete the flag and the off path. |
| `attachments` | Chat files: attaching and uploading, and downloading files. Off sends text only and lists files without a download link. | Harklight web delivery owner | `wi_cf6ed278` | off | off | A live upload above the inline limit (256 KB) has passed, it has been on for customers, and chat files are accepted. Then delete the flag and the off path. |

## The `#preview` tester switch

Not a flag, but tied to them. Opening the site with `#preview` turns every flag
on in that one browser, for testing a deployment before its flags are on for
customers; `#preview-off` turns that back off. It changes nothing for anyone
else.

- Owner: Harklight web delivery owner (`wi_cf6ed278`).
- Remove when: all three flags above are removed, so there is nothing left to
  preview.
