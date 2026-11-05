import { mkdir, copyFile, cp } from 'node:fs/promises';
await mkdir(new URL('./public/', import.meta.url), { recursive: true });
for (const name of ['index.html', 'app.js', 'schedule-ui.js', 'admin.html', 'admin.js', 'schedule.mjs']) await copyFile(new URL(name, import.meta.url), new URL(`public/${name}`, import.meta.url));
await cp(new URL('./images/', import.meta.url), new URL('./public/images/', import.meta.url), { recursive: true });
console.log('Static files prepared in public/');
