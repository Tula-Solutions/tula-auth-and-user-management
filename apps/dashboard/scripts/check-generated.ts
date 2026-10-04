import { rm } from 'node:fs/promises'
import { join } from 'node:path'

async function read(root: string, path: string): Promise<string | null> {
  const file = Bun.file(join(root, path))
  return (await file.exists()) ? file.text() : null
}

/**
 * Run a generator in place and report which generated files it changed, leaving the tree as
 * it was found.
 *
 * The files are put back whatever happens: a check that runs on a working tree (`verify`, the
 * Stop hook) must not leave it modified when a generator crashes half-way. A file the
 * generator created that was not there before is removed again.
 *
 * @param root - The package's directory.
 * @param paths - The generated files, relative to `root`.
 * @param generate - Regenerates them in place.
 * @returns The paths whose regenerated contents differ from what was there.
 * @throws Whatever `generate` throws, after the files are restored.
 */
export async function checkGenerated(
  root: string,
  paths: readonly string[],
  generate: () => Promise<void>
): Promise<string[]> {
  const before = await Promise.all(paths.map((path) => read(root, path)))
  try {
    await generate()
    const after = await Promise.all(paths.map((path) => read(root, path)))
    return paths.filter((_, index) => before[index] !== after[index])
  } finally {
    await Promise.all(
      paths.map((path, index) => {
        const content = before[index]
        return content === null || content === undefined
          ? rm(join(root, path), { force: true })
          : Bun.write(join(root, path), content)
      })
    )
  }
}
