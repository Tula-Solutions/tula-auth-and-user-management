// A preload for the lazy-loading test (`bun --preload`): when the process exits, write the
// path of every module it loaded to the file named by TULA_TEST_LOADED_MODULES. Bun keeps
// both ES modules and CommonJS ones in `require.cache`.
import { writeFileSync } from 'node:fs'

const target = process.env.TULA_TEST_LOADED_MODULES
if (target) {
  process.on('exit', () => {
    writeFileSync(target, JSON.stringify(Object.keys(require.cache)))
  })
}
