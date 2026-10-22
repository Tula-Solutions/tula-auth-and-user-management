import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

// Writes public/og.png, the 1200x630 social card: paper, the kit's mark in ink, the name in
// Geist and nothing else. Run by hand when the card changes
// (`bun run apps/docs/scripts/og.ts`, needs Playwright's Chromium: `bun run e2e:install`); the
// image is committed, so a build never needs a browser.

const root = join(import.meta.dir, '..')
// Embedded: a page with no address of its own may not load a file.
const font = readFileSync(join(root, 'src/assets/fonts/geist-latin-wght-normal.woff2')).toString(
  'base64'
)

const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:Geist;src:url(data:font/woff2;base64,${font});font-weight:100 900}
html,body{margin:0}
body{width:1200px;height:630px;background:#F1EFE8;color:#1A1A18;font-family:Geist,sans-serif;position:relative;overflow:hidden}
svg{position:absolute;left:96px;top:157px;width:330px}
.t{position:absolute;left:520px;top:200px}
h1{margin:0;font-size:104px;line-height:1;font-weight:600;letter-spacing:-0.035em}
h1 span{color:#5F5E5A}
p{margin:28px 0 0;font-size:34px;line-height:1.3;font-weight:400;color:#3A3935;max-width:600px;letter-spacing:-0.01em}
.f{position:absolute;left:96px;bottom:52px;font-size:24px;color:#5F5E5A;letter-spacing:0.02em}
</style>
<svg viewBox="-79 -39 158 100" fill="none" stroke="#1A1A18" stroke-width="6" stroke-linecap="round">
<path d="M0 -52V56M-60 -34H60M-26 56H26M-60 -34V-10M60 -34V-10"/>
<circle cx="-60" cy="4" r="14" fill="#1A1A18" stroke="none"/><circle cx="60" cy="4" r="14"/></svg>
<div class="t"><h1>tula <span>Auth</span></h1>
<p>Self-hosted authentication, with the data in your hands.</p></div>
<div class="f">Documentation</div>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } })
await page.setContent(html)
await page.evaluate(() => document.fonts.ready)
await page.screenshot({ path: join(root, 'public/og.png') })
await browser.close()
console.log('wrote apps/docs/public/og.png')
