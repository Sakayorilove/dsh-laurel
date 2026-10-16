import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { themeOverrides, themeOptions } from '../src/palette.mjs';

const css = await readFile(new URL('../src/theme.css', import.meta.url), 'utf8');
const runtime = (await readFile(new URL('../src/runtime.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '');
const updater = (await readFile(new URL('../src/updater.mjs', import.meta.url), 'utf8')).replace(/^export /gm, '');
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const client = (await readFile(new URL('../src/client.js', import.meta.url), 'utf8'))
  .replace("'__PARCHMENT_VERSION__'", () => JSON.stringify(version))
  .replace("'__PARCHMENT_CSS__'", () => JSON.stringify(css))
  .replace("'__PARCHMENT_TOKENS__'", () => JSON.stringify(themeOverrides))
  .replace("'__PARCHMENT_THEMES__'", () => JSON.stringify(themeOptions))
  .replace('/* __PARCHMENT_RUNTIME__ */', () => runtime)
  .replace('/* __PARCHMENT_UPDATER__ */', () => updater);
await mkdir(new URL('../lib/', import.meta.url), { recursive: true });
await writeFile(new URL('../lib/client.js', import.meta.url), client);
console.log('Built dependency-free browser plugin: lib/client.js');
