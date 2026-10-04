#!/usr/bin/env bun
// The `tula` executable. Bun, because the first thing every command does is import the
// project's `tula.config.ts`, which Bun runs as it is (ADR 0030).
import { main } from './index'

process.exit(await main(process.argv.slice(2)))
