// What must never work: a secret written in the file. `loadConfig` refuses it at run time
// (defineConfig would refuse it at compile time, which is why this one is a plain object).
export default {
  environments: {
    dev: { providers: { google: { clientId: 'g', clientSecret: 'literal-secret-value-123' } } },
  },
}
