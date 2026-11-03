// An ordinary plugin: nothing here may be reported by
// .semgrep/plugin-risk.yml (semgrep --test fails on any finding without a
// `ruleid:` annotation).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Plugin } from "@vestra-player/sdk";
import { helper } from "./helper.ts";

declare const plugin: Plugin & { dataDirectory: string };

export async function activate(): Promise<void> {
  const directory = join(plugin.dataDirectory, "cache");
  await mkdir(directory, { recursive: true });
  const file = join(directory, "state.json");
  await writeFile(file, JSON.stringify({ at: Date.now() }));
  const text = await readFile(file, "utf8");
  const digest = createHash("sha256").update(text).digest("hex");
  // ok: vestra-path-outside-plugin
  const parts = "a/b/c".split("/");
  // ok: vestra-path-outside-plugin
  const nested = relative(directory, file);
  const here = fileURLToPath(import.meta.url);
  // ok: vestra-dynamic-import
  const strings = await import("./strings.ts");
  // ok: vestra-dynamic-code
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: digest });
  // ok: vestra-dynamic-code
  setTimeout(() => worker.terminate(), 1000);
  // ok: vestra-obfuscation
  const short = "aGVsbG8gd29ybGQ=";
  // ok: vestra-credentials
  const lang = process.env.LANG;
  // ok: vestra-network-host
  const label = "http is mentioned here, not a URL";
  helper(parts, nested, here, strings, short, lang, label);
}

export function settings(): unknown {
  // ok: vestra-dynamic-code
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { eval: false });
  // ok: vestra-dynamic-code
  const icon = "data:image/png;base64,iVBORw0KGgo=";
  // ok: vestra-credentials
  const options = { ...defaults(), lang: process.env.LANG };
  return [worker, icon, options];
}
declare function defaults(): Record<string, string>;
