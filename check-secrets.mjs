import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('./', import.meta.url));
const skip = new Set(['node_modules', '.git', '.wrangler']);
const token = /(?<![A-Za-z0-9_-])\d{6,12}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/;
const sensitive = /^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|.*\.(?:pem|key|p12))$/i;
const violations = [];
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) { violations.push(path.relative(root,path.join(directory,entry.name))); continue; }
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (!skip.has(entry.name)) await scan(filename); continue; }
    if (entry.name !== '.env.example' && sensitive.test(entry.name)) violations.push(path.relative(root,filename));
    if (token.test(await readFile(filename, 'utf8'))) violations.push(path.relative(root,filename));
  }
}
await scan(root);
if (violations.length) { console.error('Potential secret files (contents hidden):\n' + [...new Set(violations)].join('\n')); process.exitCode = 1; }
else console.log('Secret scan passed.');
