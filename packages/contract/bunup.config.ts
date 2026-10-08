import { defineConfig } from 'bunup'

// One entry per `exports` subpath (package.json › publishConfig.exports). The eight besides the
// index import no Zod, which is what lets an SDK use them without a schema library in the bundle.
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/custom-claims.ts',
    'src/error-codes.ts',
    'src/event-types.ts',
    'src/headers.ts',
    'src/issuer.ts',
    'src/password-rules.ts',
    'src/theme.ts',
    'src/webhook-signature.ts',
  ],
  // The output mirrors `src/` (`dist/index.js`), which is what `publishConfig.exports` names.
  // Said outright: left to the bundler, the layout became `dist/src/…` with the ninth entry
  // point (bunup 0.16.32 on Bun 1.4.2), and `packages:check` found no entry point at all.
  sourceBase: './src',
  format: ['esm'],
  // Runs anywhere the contract does: browsers, React Native, Node, Bun, edge runtimes.
  target: 'browser',
  // Types are inferred from Zod schemas, so declarations need the compiler, not isolated
  // declarations.
  dts: { inferTypes: true },
  // Dependencies (zod) stay imports; nothing is bundled into the output.
  packages: 'external',
})
