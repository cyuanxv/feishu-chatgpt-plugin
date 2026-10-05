import { readdir, readFile, lstat } from 'node:fs/promises';
import { relative, resolve, join } from 'node:path';

// Audit the release allowlist only. Never inspect ambient credentials or unrelated directories.
const root = resolve(import.meta.dirname, '..');
const roots = ['apps', 'packages', 'tests', 'docs', 'infra', 'scripts', '.github'];
const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', '.env.example', '.gitignore'];
async function visit(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error('Source export cannot include symlinks.');
  if (stat.isDirectory()) for (const entry of await readdir(path)) await visit(join(path, entry));
  else files.push(relative(root, path));
}
for (const directory of roots) await visit(join(root, directory));
const prohibitedPath = /(^|\/)(?:node_modules|private-reference|\.git|\.env(?:\..*)?|dist|coverage)(?:\/|$)/;
const suspiciousValue = /(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
for (const path of files) {
  if (path !== '.env.example' && prohibitedPath.test(path)) throw new Error(`Excluded source path: ${path}`);
  if (/\.(?:docx|pdf|zip|png|jpg|pem|p12)$/i.test(path)) throw new Error(`Unreviewed binary asset: ${path}`);
  if (/\.(?:orig|rej|patch|pending|bak)$/i.test(path)) throw new Error(`Unreviewed editor/patch backup: ${path}`);
  const content = await readFile(join(root, path), 'utf8');
  if (suspiciousValue.test(content)) throw new Error(`Potential secret detected in source path: ${path}`);
}
if (process.argv.includes('--list')) for (const path of [...new Set(files)].sort()) console.log(path);
else console.log(`Source allowlist checked: ${files.length} text files; private reference, dependencies and build output excluded. This is a limited pattern check, not a complete security audit.`);
