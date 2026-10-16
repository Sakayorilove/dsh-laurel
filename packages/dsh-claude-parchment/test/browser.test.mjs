import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startPreview } from '../scripts/preview.mjs';
import { palettes, overrides, themes } from '../src/palette.mjs';

let server, browser, origin;
before(async () => {
  server = await startPreview(0);
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function pageFixture(extra = '') {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/?test=1${extra}`);
  await page.locator('[data-cp-settings]').waitFor({ state: 'attached' });
  await page.locator('#open-settings').click();
  return { context, page, errors };
}
const active = page => page.evaluate(() => document.documentElement.hasAttribute('data-cp-active'));
async function settle(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }

test('trading themes switch one layer, persist across tabs and reload, and retract completely', async () => {
  const { context, page, errors } = await pageFixture();
  const other = await context.newPage();
  await other.goto(`${origin}/?test=1`);
  await other.locator('[data-cp-settings]').waitFor({ state: 'attached' });
  await page.getByRole('radio', { name: /Robinhood/ }).check();
  assert.equal(await active(page), false);
  assert.equal(await page.evaluate(() => window.__host.layers.size), 0);
  await page.getByRole('switch').check();
  for (const [id, label] of [['robinhood', /Robinhood/], ['binance', /币安/], ['bitget', /Bitget/]]) {
    await page.getByRole('radio', { name: label }).check();
    await other.waitForFunction(id => document.documentElement.dataset.cpTheme === id, id);
    for (const mode of ['light', 'dark']) {
      await page.evaluate(mode => window.__host.mode(mode), mode);
      assert.equal(await page.evaluate(() => window.__host.layers.size), 1);
      const canvas = await page.evaluate(() => document.body.style.getPropertyValue('--cp-canvas'));
      assert.equal(canvas, themes[id][mode].canvas);
      assert.doesNotMatch(await page.locator('.fixture_markdown').first().evaluate(el => getComputedStyle(el).fontFamily), /Georgia/);
    }
    await page.reload();
    await page.locator('[data-cp-settings]').waitFor({ state: 'attached' });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.cpTheme), id);
    await page.locator('#open-settings').click();
  }
  await page.getByRole('radio', { name: 'Claude 羊皮纸', exact: true }).check();
  assert.match(await page.locator('.fixture_markdown').first().evaluate(el => getComputedStyle(el).fontFamily), /Georgia/);
  assert.equal(await page.locator('[class*="_bubble"]').first().evaluate(el => getComputedStyle(el).borderRadius), '12px');
  assert.equal(await page.locator('[class*="_bubble"]').first().evaluate(el => getComputedStyle(el).boxShadow), 'none');
  assert.equal(await page.locator('[class*="_sidebarCol"]').evaluate(el => getComputedStyle(el).boxShadow), 'none');
  await page.getByRole('switch').uncheck();
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-cp-theme')), false);
  assert.equal(await page.evaluate(() => window.__host.layers.size), 0);
  assert.equal(await page.evaluate(() => document.body.style.getPropertyValue('--cp-accent')), '');
  assert.deepEqual(errors, []);
  await context.close();
});

test('old preferences migrate without enabling a new theme; failed saves retain the applied theme', async () => {
  const { context, page } = await pageFixture();
  await page.evaluate(() => localStorage.setItem('dsh.claude-parchment.v1', JSON.stringify({ enabled: true })));
  await page.reload();
  await page.locator('[data-cp-settings]').waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.cpTheme), 'parchment');
  await page.locator('#open-settings').click();
  await page.getByRole('radio', { name: /Bitget/ }).check();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); }; });
  await page.getByRole('radio', { name: /Robinhood/ }).click();
  assert.equal(await page.getByRole('radio', { name: /Bitget/ }).isChecked(), true);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.cpTheme), 'bitget');
  assert.match(await page.getByRole('alert').textContent(), /无法保存/);
  await page.evaluate(() => window.__host.dispose());
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-cp-theme')), false);
  await context.close();
});

test('unknown stored theme falls back to parchment; native radio keyboard navigation works', async () => {
  const { context, page } = await pageFixture();
  await page.evaluate(() => localStorage.setItem('dsh.claude-parchment.v1', JSON.stringify({ enabled: true, theme: '__proto__' })));
  await page.reload();
  await page.locator('[data-cp-settings]').waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.cpTheme), 'parchment');
  await page.locator('#open-settings').click();
  await page.getByRole('radio', { name: 'Claude 羊皮纸', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('radio', { name: /Robinhood/ }).waitFor();
  assert.equal(await page.getByRole('radio', { name: /Robinhood/ }).isChecked(), true);
  await context.close();
});

test('the layer applies and retracts on its own, and stays independent of other host layers', async () => {
  const { context, page, errors } = await pageFixture();
  assert.equal(await active(page), false);
  assert.equal(await page.evaluate(() => window.__host.layers.size), 0);
  const beforeKeys = await page.evaluate(() => Object.keys(localStorage).sort());
  await page.getByRole('switch').check();
  assert.equal(await active(page), true);
  assert.equal(await page.evaluate(() => window.__host.layers.size), 1);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(245, 240, 228)');

  // Another plugin's layer may come and go; ours is neither paused nor removed by it.
  await page.evaluate(() => {
    window.__removeOther = window.__host.ctx.theme.overrideTokens('example-plugin/skin', {
      '--dsw-alias-bg-base': { light: '#123456', dark: '#654321' },
    });
  });
  await settle(page);
  assert.equal(await active(page), true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(245, 240, 228)');
  await page.evaluate(() => { window.__removeOther(); });
  await settle(page);
  assert.equal(await active(page), true);
  // Only our own preference key is ever written.
  const added = await page.evaluate(keys => Object.keys(localStorage).sort().filter(key => !keys.includes(key)), beforeKeys);
  assert.deepEqual(added, ['dsh.claude-parchment.v1']);
  await page.getByRole('switch').uncheck();
  assert.equal(await active(page), false);
  assert.equal(await page.evaluate(() => window.__host.layers.size), 0);
  assert.equal(await page.evaluate(() => document.body.style.getPropertyValue('--cp-canvas')), '');
  assert.deepEqual(errors, []);
  await context.close();
});

test('persisted theme follows light, dark, and the OS; unload restores host presentation', async () => {
  const { context, page, errors } = await pageFixture();
  await page.getByRole('switch').check();
  await page.evaluate(() => window.__host.mode('dark'));
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(38, 36, 33)');
  assert.match(await page.locator('[role=status]').textContent(), /夜间/);
  await page.reload();
  await page.locator('[data-cp-settings]').waitFor({ state: 'attached' });
  assert.equal(await active(page), true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => window.__host.mode('system'));
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(38, 36, 33)');
  await page.emulateMedia({ colorScheme: 'light' });
  await settle(page);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(245, 240, 228)');
  await page.evaluate(() => window.__host.dispose());
  assert.equal(await active(page), false);
  assert.equal(await page.evaluate(() => window.__host.layers.size), 0);
  assert.equal(await page.locator('style[data-claude-parchment-style]').count(), 0);
  // Disposal is final: a later host theme change never revives the layer.
  await page.evaluate(() => window.__host.mode('dark'));
  await settle(page);
  assert.equal(await active(page), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('storage failures preserve the last applied preference and show recovery text', async () => {
  const { context, page } = await pageFixture();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); }; });
  await page.getByRole('switch').click();
  assert.equal(await active(page), false);
  assert.match(await page.getByRole('alert').textContent(), /无法保存/);
  await context.close();
});

test('cross-tab preference changes synchronize through our own preference key', async () => {
  const { context, page } = await pageFixture();
  const other = await context.newPage();
  await other.goto(`${origin}/?test=1`);
  await other.locator('[data-cp-settings]').waitFor({ state: 'attached' });
  await page.getByRole('switch').check();
  await other.waitForFunction(() => document.documentElement.hasAttribute('data-cp-active'));
  await page.getByRole('switch').uncheck();
  await other.waitForFunction(() => !document.documentElement.hasAttribute('data-cp-active'));
  assert.deepEqual(await other.evaluate(() => Object.keys(localStorage).sort()), ['dsh.claude-parchment.v1']);
  await context.close();
});

test('both palettes keep body, secondary, accent, code and form borders readable', () => {
  const luminance = value => value.slice(1).match(/../g).map(hex => parseInt(hex, 16) / 255)
    .map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
    .reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  for (const [mode, p] of Object.entries(Object.fromEntries(Object.entries(themes).flatMap(([id, pair]) => Object.entries(pair).map(([mode, values]) => [id + '/' + mode, values]))))) {
    for (const background of ['canvas', 'surface', 'sidebar', 'user', 'hover', 'selected']) {
      for (const text of ['text', 'secondary', 'muted']) assert.ok(contrast(p[text], p[background]) >= 4.5, `${mode} ${text}/${background}: ${contrast(p[text], p[background])}`);
    }
    assert.ok(contrast(p.onAccent, p.accent) >= 4.5, `${mode} button`);
    assert.ok(contrast(p.strongBorder, p.surface) >= 3, `${mode} input border`);
    for (const syntax of ['constant', 'string', 'keyword', 'function', 'muted']) assert.ok(contrast(p[syntax], p.code) >= 4.5, `${mode} syntax ${syntax}`);
  }
  for (const pair of Object.values(overrides)) assert.equal(typeof pair.light + typeof pair.dark, 'stringstring');
});

test('conversation typography preserves host sizing and keeps long content scrolling locally', async () => {
  for (const mode of ['light', 'dark']) {
    for (const width of [1440, 900, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: mode });
      const page = await context.newPage();
      await page.goto(`${origin}/?mode=${mode}`);
      await page.locator('[data-cp-settings]').waitFor({ state: 'attached' });
      await settle(page);
      const reading = page.locator('.fixture_markdown').first();
      const metrics = await page.evaluate(() => {
        const prose = getComputedStyle(document.querySelector('.fixture_markdown'));
        const bubble = getComputedStyle(document.querySelector('.Sixlwa_bubble'));
        const column = document.querySelector('.fixture-column').getBoundingClientRect();
        const composer = document.querySelector('[data-composer-card]').getBoundingClientRect();
        return { family: prose.fontFamily, size: parseFloat(prose.fontSize), leading: parseFloat(prose.lineHeight), bubbleFamily: bubble.fontFamily,
          radius: bubble.borderRadius, width: column.width, center: column.x + column.width / 2, composerCenter: composer.x + composer.width / 2,
          turnGap: getComputedStyle(document.querySelector('[data-chat-group-part="response"]')).marginTop };
      });
      assert.match(metrics.family, /Georgia/);
      assert.equal(metrics.size, 16);
      assert.ok(Math.abs(metrics.leading / metrics.size - (mode === 'dark' ? 1.85 : 1.8)) < .01);
      assert.doesNotMatch(metrics.bubbleFamily, /Georgia/);
      assert.equal(metrics.radius, '12px');
      assert.ok(metrics.width <= 720 && metrics.width <= width - 64);
      assert.ok(Math.abs(metrics.center - metrics.composerCenter) < 1);
      assert.equal(metrics.turnGap, width < 600 ? '24px' : '28px');

      // User font preferences and dragged widths are shared host axes, not plugin storage.
      await page.evaluate(() => document.body.style.setProperty('--dsh-content-font-size', '22px'));
      assert.equal(await reading.evaluate(el => getComputedStyle(el).fontSize), '22px');
      if (width === 1440) {
        await page.evaluate(() => document.querySelector('[data-conversation-content]').style.setProperty('--dsh-chat-user-width', '600px'));
        assert.equal(await page.locator('.fixture-column').evaluate(el => el.getBoundingClientRect().width), 600);
      }

      // Long code and wide tables must scroll inside the transcript, never the page.
      await page.evaluate(() => {
        document.querySelector('pre code').textContent = 'const veryLongLine = ' + 'unbroken_identifier_'.repeat(30);
        const table = document.createElement('div');
        table.className = 'md-table-wide';
        table.style.overflowX = 'auto';
        const row = document.createElement('table');
        row.style.width = '1200px';
        row.innerHTML = '<tr><td>wide table</td></tr>';
        table.append(row);
        document.querySelector('.fixture_markdown').append(table);
      });
      assert.equal(await page.locator('pre').evaluate(el => el.scrollWidth > el.clientWidth), true);
      assert.equal(await page.locator('.md-table-wide').evaluate(el => el.scrollWidth > el.clientWidth), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator('[data-conversation-scroll]').evaluate(el => el.scrollWidth <= el.clientWidth), true);

      await context.close();
    }
  }
});

test('version controls distinguish a verified installation from the running client', async () => {
  const { context, page, errors } = await pageFixture('&installed=1.1.0');
  assert.equal(await page.locator('[data-cp-loaded]').textContent(), 'v1.3.1');
  assert.equal(await page.locator('[data-cp-installed]').textContent(), 'v1.1.0');
  assert.match(await page.locator('[data-cp-update-status]').textContent(), /版本不一致/);
  await page.getByRole('button', { name: '手动更新', exact: true }).click();
  const input = page.getByLabel('新版安装包路径');
  assert.equal(await input.evaluate(el => el === document.activeElement), true);
  const nextPath = 'C:\\packages\\dsh-claude-parchment-1.4.0.tgz';
  await input.fill(nextPath);
  await page.evaluate(() => { window.__host.installer.hold = true; });
  await page.getByRole('button', { name: '安装更新', exact: true }).click();
  await page.waitForFunction(() => typeof window.__host.installer.release === 'function');
  assert.equal(await page.getByRole('button', { name: '检查版本', exact: true }).isDisabled(), true);
  assert.equal(await input.isDisabled(), true);
  await page.evaluate(() => { window.__host.installer.release(); });
  await page.waitForFunction(() => document.querySelector('[data-cp-installed]').textContent === 'v1.4.0');
  assert.equal(await page.locator('[data-cp-loaded]').textContent(), 'v1.3.1');
  assert.match(await page.locator('[data-cp-update-status]').textContent(), /新版已安装.*完全退出/);
  const calls = await page.evaluate(() => window.__host.installer.calls);
  assert.deepEqual(calls, [{ method: 'inspect', path: nextPath }, { method: 'installBundle', path: nextPath, options: { enabled: false } }]);
  await page.getByRole('button', { name: '检查版本', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-cp-update-status]').textContent.includes('版本不一致'));
  assert.deepEqual(errors, []);
  await context.close();
});

test('installation policy errors remain visible and do not change the displayed versions', async () => {
  const { context, page, errors } = await pageFixture();
  await page.getByRole('switch').check();
  await page.evaluate(() => {
    window.__host.installer.failure = { ok: true, value: { application: 'failed', packageResult: { exitCode: 1, output: 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION: dshmarket blocked' } } };
  });
  await page.getByRole('button', { name: '手动更新', exact: true }).click();
  await page.getByLabel('新版安装包路径').fill('C:\\packages\\dsh-claude-parchment-1.4.0.tgz');
  await page.getByRole('button', { name: '安装更新', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').textContent(), /更新未完成/);
  assert.match(await page.locator('[data-cp-update-status]').textContent(), /MINIMUM_RELEASE_AGE/);
  assert.equal(await page.locator('[data-cp-loaded]').textContent(), 'v1.3.1');
  assert.equal(await page.locator('[data-cp-installed]').textContent(), 'v1.3.1');
  assert.equal(await active(page), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test('installer unavailable does not prevent the theme', async () => {
  const { context, page, errors } = await pageFixture('&no-remote=1&lang=en');
  assert.equal(await page.locator('[data-cp-loaded]').textContent(), 'v1.3.1');
  assert.match(await page.getByRole('alert').textContent(), /installer is unavailable/);
  await page.getByRole('switch').check();
  assert.equal(await active(page), true);
  await page.getByRole('switch').uncheck();
  assert.equal(await active(page), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('light/dark desktop and mobile previews have no horizontal overflow or script errors', async () => {
  for (const mode of ['light', 'dark']) {
    for (const [name, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
      const context = await browser.newContext({ viewport, colorScheme: mode, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/?mode=${mode}`);
      await page.locator('[data-cp-settings]').waitFor({ state: 'attached' });
      await page.evaluate(() => document.fonts.ready);
      await settle(page);
      assert.equal(await active(page), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('#open-settings').click();
      assert.equal(await page.getByRole('switch').isVisible(), true);
      await page.getByRole('button', { name: '手动更新', exact: true }).click();
      await page.getByLabel('新版安装包路径').fill('C:\\packages\\dsh-claude-parchment-1.4.0.tgz');
      await page.getByRole('button', { name: '安装更新', exact: true }).scrollIntoViewIfNeeded();
      assert.equal(await page.locator('[data-cp-settings]').evaluate(el => el.scrollWidth <= el.clientWidth), true);
      assert.equal(await page.getByLabel('新版安装包路径').isVisible(), true);
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
});
