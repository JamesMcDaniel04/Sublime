import { expect, test } from '@playwright/test'

test('public landing page renders without horizontal overflow', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle(/Sublime/i)
  await expect(page.locator('body')).toBeVisible()
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  expect(overflows).toBe(false)
})

test('login page presents an authentication entry point', async ({ page }) => {
  await page.goto('/login')
  await expect(page.locator('body')).toContainText(/sign in|log in|continue/i)
})

test('protected product routes preserve the requested return path', async ({ page }) => {
  await page.goto('/g/all/flows')
  await expect(page).toHaveURL(/\/login/)
  expect(new URL(page.url()).searchParams.get('return_to')).toBe('/g/all/flows')
})

test('public health probe exposes no infrastructure details', async ({ request }) => {
  const response = await request.get('/api/health')
  expect([200, 503]).toContain(response.status())
  const body = await response.json()
  expect(Object.keys(body).sort()).toEqual(['status', 'timestamp'])
  expect(JSON.stringify(body)).not.toMatch(/prisma|database|queue|dead.?letter|redis/i)
})
