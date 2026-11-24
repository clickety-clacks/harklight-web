# Feature flags

Flags that hide unfinished features. See the feature-flag rules in
[AGENTS.md](../AGENTS.md). Add a row when you add a flag, update it when its
default or its production state changes, and delete the row in the pull request
that removes the flag.

Flags live in `src/config.ts`. The deployment overrides them with
`/app/config.json` (`docs/deploy.md`).

The owner of every flag below is the web client delivery owner, accountable to
the Web product owner.

| Flag | Purpose | Owner | Work item | Default | In production | Remove when |
| --- | --- | --- | --- | --- | --- | --- |
| `webClient` | Customers can use web messaging. Off shows the "coming soon" page, and no connection to the Server opens. | Web client delivery owner | `wi_cf6ed278` | off | off | Customers are switched on and the full live message checks pass on hosted. Delete the flag and the "coming soon" page. |
| `answerForms` | Draws custom answer forms. Off offers the plain Reply and No comment, and says the custom screen is not shown. | Web client delivery owner | `wi_cf6ed278` | off | off | Custom forms pass their live check on hosted with customers on. Delete the flag and the off path. |
| `attachments` | Chat files: attaching and uploading, and downloading files. Off sends text only and lists files without a download link. | Web client delivery owner | `wi_cf6ed278` | off | off | A live upload above 256 KB passes on hosted and files are on for customers. Delete the flag and the off path. |
| `fyiInbox` | Groups FYIs into an Inbox summary and full list. | Web client delivery owner | `wi_ed1f7278` | on | off | The paired FYI rollout and browser verification pass. |

## The `#preview` tester switch

A testing tool, not a release flag. Opening the site with `#preview` turns
every flag on in that one browser, for testing a deployment before its flags
are on for customers; `#preview-off` turns that back off. It changes nothing
for anyone else.

- Owner: the web client delivery owner (`wi_cf6ed278`).
- Remove when: all flags above are removed, so there is nothing left to
  preview.
