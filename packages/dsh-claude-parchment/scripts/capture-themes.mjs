/** Browser interaction evidence against the preview services; not an Electron acceptance test. */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startPreview } from './preview.mjs';
const out = resolve(process.argv[2] || 'artifacts/trading-evidence');
await mkdir(out, { recursive: true });
const server = await startPreview(0);
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const theme of ['robinhood', 'binance', 'bitget']) {
    for (const mode of ['dark', 'light']) {
      for (const [size, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
        const page = await browser.newPage({ viewport, colorScheme: mode, reducedMotion: 'reduce' });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}&theme=${theme}`);
        await page.locator('[data-cp-settings]').waitFor({ state: 'attached' });
        await page.evaluate(() => document.fonts.ready);
        await page.locator('[data-composer-input]').focus();
        const metrics = await page.evaluate(() => {
          const composer = getComputedStyle(document.querySelector('[data-composer-card]'));
          const bubble = getComputedStyle(document.querySelector('[class*="_bubble"]'));
          const sidebar = getComputedStyle(document.querySelector('[class*="_sidebarCol"]'));
          return { theme: document.documentElement.dataset.cpTheme, width: innerWidth,
            overflow: document.documentElement.scrollWidth > innerWidth, shadow: composer.boxShadow,
            composerRadius: composer.borderTopLeftRadius, bubbleRadius: bubble.borderRadius, bubbleShadow: bubble.boxShadow,
            sidebarShadow: sidebar.boxShadow, sidebarOverflow: sidebar.overflow,
            transition: composer.transitionDuration, accent: getComputedStyle(document.body).getPropertyValue('--cp-accent') };
        });
        assert.equal(metrics.theme, theme);
        assert.equal(metrics.overflow, false);
        assert.equal(metrics.transition, '0s');
        assert.notEqual(metrics.shadow, 'none');
        assert.equal(metrics.composerRadius, { robinhood: '0px', binance: '4px', bitget: '12px' }[theme]);
        assert.equal(metrics.bubbleRadius, { robinhood: '0px', binance: '4px', bitget: '12px 12px 3px' }[theme]);
        assert.notEqual(metrics.bubbleShadow, 'none');
        assert.notEqual(metrics.sidebarShadow, 'none');
        assert.equal(metrics.sidebarOverflow, 'hidden');
        const name = `${theme}-${mode}-${size}`;
        await page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
        if (size === 'mobile') {
          await page.getByRole('button', { name: '展开侧栏' }).click();
          assert.equal(await page.locator('[class*="_sidebarCol"]').evaluate(el => getComputedStyle(el).position), 'fixed');
          assert.equal(await page.locator('[class*="_sidebarCol"]').evaluate(el => el.getBoundingClientRect().width), 248);
          if (mode === 'dark') await page.screenshot({ path: resolve(out, `${name}-sidebar.png`), fullPage: true });
          await page.getByRole('button', { name: '收起侧栏' }).click();
        }
        await page.locator('#open-settings').click();
        assert.equal(await page.getByRole('radio').count(), 4);
        assert.equal(await page.getByRole('radio', { checked: true }).inputValue(), theme);
        assert.equal(await page.locator('[data-cp-settings]').evaluate(el => el.scrollWidth > el.clientWidth), false);
        if (mode === 'dark') await page.screenshot({ path: resolve(out, `${name}-settings.png`), fullPage: true });
        assert.deepEqual(errors, []);
        results.push({ name, ...metrics, errors });
        await page.close();
      }
    }
  }
  await writeFile(resolve(out, 'browser-results.json'), JSON.stringify({ passed: true, host: 'preview service fixture', results }, null, 2) + '\n');
  console.log(`Verified ${results.length} theme/mode/viewport combinations; screenshots: ${out}`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
