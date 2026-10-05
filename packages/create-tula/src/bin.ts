#!/usr/bin/env bun
// The `create-tula` executable (`bun create tula`, `bunx create-tula`).
import { main, processIo } from './main'

process.exit(await main(process.argv.slice(2), processIo()))
