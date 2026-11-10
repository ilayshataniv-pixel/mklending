import { mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('./', import.meta.url));
const landing = new URL('../', import.meta.url);
const output = path.resolve(root, 'public');
if (path.dirname(output) !== path.resolve(root) || path.basename(output) !== 'public') throw new Error('Invalid output directory');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ['app.js', 'schedule-ui.js', 'admin.html', 'admin.css', 'admin.js', 'schedule.mjs', 'auth.html', 'account.html', 'account.css', 'account.js']) {
  await copyFile(new URL(name, import.meta.url), new URL(`public/${name}`, import.meta.url));
}
for (const name of ['landing.css', 'header.css', 'english-study-restored.webp']) {
  await copyFile(new URL(name, landing), new URL(`public/${name}`, import.meta.url));
}
await mkdir(new URL('./public/teacher/', import.meta.url));
for (const name of ['maria-park.webp', 'maria-portrait.webp', 'maria-closeup.webp']) {
  await copyFile(new URL(`teacher/${name}`, landing), new URL(`public/teacher/${name}`, import.meta.url));
}
const html = await readFile(new URL('index.html', landing), 'utf8');
const pagesScript = '<script src="pages-entry.js" defer></script>';
if (!html.includes(pagesScript)) throw new Error('Missing GitHub Pages entry script');
const workerScripts = ['account.js', 'app.js', 'schedule-ui.js'].map(file => `<script src="${file}" defer></script>`).join('\n');
await writeFile(new URL('./public/index.html', import.meta.url), html.replace(pagesScript, workerScripts));
await import('./check-secrets.mjs');
if (process.exitCode) throw new Error('Secret scan failed; do not publish this build');
console.log('Static files prepared in public/');
