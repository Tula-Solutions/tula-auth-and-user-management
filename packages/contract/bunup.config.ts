import { defineConfig } from 'bunup'

// One entry per `exports` subpath (package.json › publishConfig.exports). The five besides the
// index import no Zod, which is what lets an SDK use them without a schema library in the bundle.
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/error-codes.ts',
    'src/headers.ts',
    'src/issuer.ts',
    'src/password-rules.ts',
    'src/theme.ts',
  ],
  format: ['esm'],
  // Runs anywhere the contract does: browsers, React Native, Node, Bun, edge runtimes.
  target: 'browser',
  // Types are inferred from Zod schemas, so declarations need the compiler, not isolated
  // declarations.
  dts: { inferTypes: true },
  // Dependencies (zod) stay imports; nothing is bundled into the output.
  packages: 'external',
})
