import { build } from "esbuild";
import { mkdir, rm, copyFile, cp } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist/server", { recursive: true });
const options = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: false,
};
await build({
  ...options,
  entryPoints: ["src/worker.ts"],
  outfile: "dist/server/index.js",
});
await mkdir(".test-build", { recursive: true });
await build({
  ...options,
  entryPoints: ["src/testing.ts"],
  outfile: ".test-build/module.mjs",
});
await mkdir("dist/.openai", { recursive: true });
await copyFile(".openai/hosting.json", "dist/.openai/hosting.json");
await cp("drizzle", "dist/.openai/drizzle", { recursive: true });
console.log(
  "Sites Worker bundle built; build does not create a Site or credential.",
);
