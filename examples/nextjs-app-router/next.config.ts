import { join } from 'node:path'
import type { NextConfig } from 'next'

const config: NextConfig = {
  // The Tula packages are used from source inside this repository (their `exports` point at
  // `src/*.ts`), so Next.js compiles them. An app that installs them from npm needs none of
  // this.
  transpilePackages: ['@tula/nextjs', '@tula/react', '@tula/core', '@tula/contract'],
  // The workspace root: where `bun.lock` and the packages live.
  turbopack: { root: join(import.meta.dirname, '..', '..') },
  outputFileTracingRoot: join(import.meta.dirname, '..', '..'),
  devIndicators: false,
}

export default config
