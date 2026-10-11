import { readdir, readFile, lstat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
const root = resolve(".");
const files = [
  "README.md",
  "LICENSE",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "drizzle.config.ts",
  ".gitignore",
  ".openai/hosting.json",
  "runtime-check/package.json",
  "runtime-check/package-lock.json",
];
async function visit(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw Error("Symlink in source allowlist");
  if (stat.isDirectory())
    for (const name of await readdir(path)) await visit(join(path, name));
  else files.push(relative(root, path));
}
for (const name of ["src", "test", "scripts", "db", "drizzle", "docs"])
  await visit(join(root, name));
for (const name of files) {
  const body = await readFile(name, "utf8");
  if (
    /cli_[0-9a-f]{12,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
      body,
    )
  )
    throw Error("Potential credential or real App ID in source: " + name);
}
if (process.argv.includes("--list"))
  files.sort().forEach((f) => console.log(f));
else
  console.log(
    `Checked ${files.length} allowlisted text files. No dependencies, generated output, private data or credential directories exported. Limited pattern check, not a security audit.`,
  );

for (const path of ["package-lock.json", "runtime-check/package-lock.json"]) {
  const lock = JSON.parse(await readFile(path, "utf8"));
  for (const [name, value] of Object.entries(lock.packages))
    if (name && !value.version && !value.link)
      throw Error("Incomplete locked package metadata: " + name);
}
