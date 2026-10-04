import { API_URL } from '../support'
import { expect, signIn, test } from './support'

// The API reference is HTML on the origin the dashboard's cookie belongs to (ADR 0032). It
// must run under its Content-Security-Policy with nothing loaded from anywhere else. The
// fixture's `problems` check fails this test for one CSP violation or console error.

test('the API reference renders under its policy, from this origin only', async ({ page }) => {
  const requested: string[] = []
  page.on('request', (request) => requested.push(request.url()))

  // Signed in to the dashboard in this browser: the case the policy exists for.
  await signIn(page)
  const response = await page.goto(`${API_URL}/v1/docs`)
  expect(response?.status()).toBe(200)
  const csp = response?.headers()['content-security-policy'] ?? ''
  expect(csp).toContain("default-src 'none'")
  expect(csp).toContain("script-src 'self'")
  expect(csp).not.toContain('unsafe-eval')
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/)
  expect(csp).not.toContain('https:')
  expect(response?.headers()['x-content-type-options']).toBe('nosniff')

  // The reference drew the contract: its title, and an operation by its summary.
  await expect(page.getByRole('heading', { name: 'Tula Auth API' }).first()).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByText('Liveness check').first()).toBeVisible()
  // The toolbar that links out to the vendor's hosted tools is off.
  await expect(page.getByText('Deploy')).toHaveCount(0)

  // Nothing was asked of another host: no CDN, no font host, no telemetry.
  const foreign = requested.filter(
    (url) => !url.startsWith(`${API_URL}/`) && !url.startsWith('data:') && !url.startsWith('blob:')
  )
  expect(foreign).toEqual([])
  expect(requested.some((url) => url.includes('/v1/docs/assets/api-reference-'))).toBe(true)

  // No inline script in the page: every script is a file of this origin.
  const scripts = await page.evaluate(() =>
    [...document.scripts].map((script) => ({ src: script.src, inline: script.text.trim() !== '' }))
  )
  expect(scripts.length).toBeGreaterThan(0)
  for (const script of scripts) {
    expect(script.inline).toBe(false)
    expect(script.src.startsWith(`${API_URL}/v1/docs/assets/`)).toBe(true)
  }
})
