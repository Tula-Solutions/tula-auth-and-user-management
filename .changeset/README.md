# Changesets

Every change to a publishable package (`@tula/contract`, `@tula/core`, `@tula/react`) comes with a changeset:
a small Markdown file in this folder that names the packages, the kind of bump and the
changelog line.

```bash
bunx changeset          # describe a change (interactive)
bunx changeset status   # what the next release would contain
```

Versions, the prerelease mode (`pre.json`) and how a release is cut are described in
[`docs/releasing.md`](../docs/releasing.md). Nothing is published yet.
