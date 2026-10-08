import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
const manifest = JSON.parse(await readFile(".openai/hosting.json", "utf8"));
const { project_id, ...bindings } = manifest;
assert(
  project_id === undefined ||
    (typeof project_id === "string" && project_id.length > 0),
);
assert.deepEqual(bindings, { d1: "DB", r2: null, capabilities: ["mcp"] });
assert.deepEqual(
  JSON.parse(await readFile("dist/.openai/hosting.json", "utf8")),
  manifest,
);
assert.deepEqual((await readdir("dist")).sort(), [".openai", "server"]);
const source = await readFile("dist/server/index.js", "utf8");
assert(!/from ["']node:|require\(["'](?:node:)?(?:pg|http|fs)/.test(source));
assert(!/cli_[0-9a-f]{12,}/.test(source));
assert(source.length < 1000000);
const module = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);
assert.equal(typeof module.default.fetch, "function");
console.log(
  JSON.stringify({
    worker_bytes: Buffer.byteLength(source),
    module: "ESM fetch",
    site_registered: typeof project_id === "string",
    secrets_configured: false,
    capabilities: manifest.capabilities,
  }),
);
