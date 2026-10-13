---
paths:
  - "turbo.json"
  - "**/turbo.json"
  - ".claude/hooks/turbo-inputs.test.ts"
---

# Turborepo cache inputs

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Testing

- **A cached task is invalidated by every file it reaches** (`.claude/hooks/turbo-inputs.test.ts`,
  in `test:harness`). Turborepo keys a task on the files of its own package, so a package that
  imports or reads a file of another (the CLI's, MCP's, admin's and Next.js SDK's tests import
  `apps/api/src` by relative path) was served a cached "passed" when only that file changed:
  a green `verify` on a branch whose `@tula-tech/cli` tests no longer compiled. Two things make an
  outside file part of the key. A file of a workspace package the importer **declares as a
  dependency** is covered because `typecheck`, `test`, `test:coverage` and `generate:check`
  depend on `transit` (`dependsOn: ["^transit"]`, no script): never remove it from them.
  Anything else (a root file, `conformance/`, a package that cannot be a dependency) is named
  in the package's own `turbo.json` as `"$TURBO_DEFAULT$"` plus `"$TURBO_ROOT$/<path>"`, for
  those tasks and for `transit`. A file that builds such a path from separate `'..'`
  arguments is listed in that test's `CLIMBERS` with what it reads. `conformance/client-journeys.json`
  is read through `@tula-tech/conformance`'s loader, which that scan cannot follow: the same test
  holds that every package that reads it depends on `@tula-tech/conformance` (whose `turbo.json`
  names `conformance/**`) or names the file itself. When a result looks too
  good, `TURBO_FORCE=true bun run verify` runs everything without the cache.
