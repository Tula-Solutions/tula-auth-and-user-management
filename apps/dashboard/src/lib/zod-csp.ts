import { config } from 'zod'

// Zod compiles object parsers with `new Function` when it can, and finds out whether it can
// by trying. Under the dashboard's Content-Security-Policy (`script-src 'self'`, no
// `unsafe-eval`; ADR 0032) the attempt is refused and reported as a violation, so it is
// switched off before any schema parses: Zod then uses its ordinary interpreter.
//
// Imported first by the entry point. The contract's schemas load later, in the route chunks.
config({ jitless: true })
