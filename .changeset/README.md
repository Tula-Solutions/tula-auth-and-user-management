# Changesets

Every change to a publishable package (the eleven of the `fixed` group in `config.json`) comes with a changeset:
a small Markdown file in this folder that names the packages, the kind of bump and the
changelog line.

```bash
bunx changeset          # describe a change (interactive)
bunx changeset status   # what the next release would contain
```

Versions, the prerelease mode (`pre.json`) and how a release is cut are described in
[`docs/releasing.md`](../docs/releasing.md). Nine of the eleven are released to npm; the two
Expo packages are held back and move with the group's version unpublished.
