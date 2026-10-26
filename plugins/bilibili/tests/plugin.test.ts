import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  HostError,
  startPlugin,
  TestHost,
} from "@vestra-player/sdk/testing";
import activate from "../main.ts";

const directory = new URL("..", import.meta.url);
const link = "https://www.bilibili.com/video/BV1xx411c7mD";
type Locale = "en" | "zh-Hans";

/**
 * Start the plugin and press Play in its window. The window tests play a
 * Simplified Chinese user: the texts are the ones the plugin showed before
 * English source text.
 */
async function play(url = link, host = new TestHost(), locale: Locale = "zh-Hans") {
  const { stop } = await startPlugin(activate, { directory, host, locale });
  await host.command("bilibili.open").run();
  const window = host.window("dialog");
  window.emit("play", url);
  await host.settle();
  return { host, window, stop };
}
const opens = (host: TestHost) =>
  host
    .sent("source.submit")
    .filter((c) => (c.intent as { kind: string }).kind === "open");
const closes = (host: TestHost) =>
  host
    .sent("source.submit")
    .filter((c) => (c.intent as { kind: string }).kind === "close");

test("public resolver and menu entry are owned by the plugin lifetime", async () => {
  const { host, stop } = await startPlugin(activate, {
    directory,
    locale: "zh-Hans",
  });
  assert.deepEqual(host.sent("sourceResolvers.register"), [
    {
      id: "bilibili",
      schemes: ["http", "https"],
      hosts: ["bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"],
    },
  ]);
  const command = host.command("bilibili.open");
  assert.deepEqual(command.declaration, {
    title: "VestraBili…",
    path: ["@open", "VestraBili…"],
    order: 112,
    group: "open",
    radio: false,
    bindings: [],
    focus: null,
    repeat: false,
  });
  assert.deepEqual(command.display.path, ["打开", "VestraBili…"]);
  await command.run();
  const window = host.window("dialog");
  assert.equal(window.file, "dialog.slint");
  assert.deepEqual(window.callbacks.sort(), ["cancel", "play"]);
  assert.deepEqual(window.props, {
    url: "",
    status: "输入 Bilibili 视频链接。",
    busy: false,
  });
  await stop();
  assert.equal(host.resolvers.size, 0);
});

test("resolver rejects non-video pages instead of extracting them", async () => {
  const { host, stop } = await startPlugin(activate, {
    directory,
    locale: "zh-Hans",
  });
  host.emit("source.resolveRequest", {
    requestId: 7,
    resolverId: "bilibili",
    url: "https://www.bilibili.com/live/1",
  });
  await host.settle();
  const [reply] = host.sent("sourceResolvers.respond");
  assert.equal(reply!.requestId, 7);
  // The failure is a text value: the player shows it in the user's language.
  const error = reply!.error as { $vestraText: string };
  assert.equal(
    error.$vestraText,
    "Enter a bilibili.com/video/… or b23.tv/… video link.",
  );
  assert.equal(
    host.translate(error.$vestraText),
    "请输入 bilibili.com/video/… 或 b23.tv/… 视频链接。",
  );
  await stop();
});

test("English is the source: menu and window status", async () => {
  const { host, window, stop } = await play(
    "https://example.com/video/BV1",
    new TestHost(),
    "en",
  );
  try {
    assert.deepEqual(host.command("bilibili.open").display.path, [
      "Open",
      "VestraBili…",
    ]);
    assert.equal(
      window.props.status,
      "Enter a bilibili.com/video/… or b23.tv/… video link.",
    );
    window.emit("cancel");
    await host.settle();
    await host.command("bilibili.open").run();
    assert.equal(
      host.window("dialog").props.status,
      "Enter a Bilibili video link.",
    );
  } finally {
    await stop();
  }
});

test("the manifest's display texts are English with a Simplified Chinese translation", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", directory), "utf8"),
  );
  assert.equal(
    manifest.id,
    "zysilm.bilibili",
    "the id stays: the store and existing installs know the plugin by it",
  );
  assert.equal(manifest.name, "VestraBili");
  assert.equal(manifest.minPlayerVersion, "0.4.3");
  for (const value of [
    manifest.name,
    manifest.punchline,
    manifest.description,
    ...manifest.tags,
  ])
    assert.doesNotMatch(
      value,
      /[　-鿿＀-￯]/,
      "English source text",
    );
  const { host, stop } = await startPlugin(activate, {
    directory,
    locale: "zh-Hans",
  });
  assert.equal(host.translate(manifest.name), "VestraBili");
  assert.equal(
    host.translate(manifest.punchline),
    "粘贴链接播放 Bilibili 单个视频",
  );
  assert.equal(
    host.translate(manifest.description),
    "打开 Bilibili 视频链接（BV 号、av 号、b23.tv 短链）直接播放。需要本机安装 yt-dlp。",
  );
  assert.deepEqual(
    manifest.tags.map((tag: string) => host.translate(tag)),
    ["网络视频", "Bilibili"],
  );
  await stop();
});

test("invalid links are shown without opening anything", async () => {
  const { host, window, stop } = await play("https://example.com/video/BV1");
  assert.equal(opens(host).length, 0);
  assert.equal(
    window.props.status,
    "请输入 bilibili.com/video/… 或 b23.tv/… 视频链接。",
  );
  assert.equal(window.props.busy, false);
  await stop();
});

test("ready requires the backend ready phase, not submit acceptance", async () => {
  const { host, window, stop } = await play(`${link}#part`);
  assert.deepEqual(
    opens(host).map((c) => c.intent),
    [{ kind: "open", source: link, startPaused: false }],
  );
  assert.equal(window.props.status, "正在解析视频和音频…");
  assert.equal(window.props.busy, true);
  window.emit("play", link); // a second Play while busy is ignored
  host.setSource({ phase: "ready", duration: 60 });
  await host.settle(250); // no events capability: the SDK polls the source state
  assert.equal(opens(host).length, 1);
  assert.equal(window.props.status, "视频已就绪。");
  assert.equal(window.props.busy, false);
  await stop();
});

test("a lost submit reply is recovered by the same operation id without reopening", async () => {
  const host = new TestHost();
  const ticket = {
    stamp: { generation: 1, intentVersion: 1 },
    cycle: 1,
    owner: 1,
  };
  host.handle("source.submit", () => {
    host.setSource({
      stamp: ticket.stamp,
      cycle: 1,
      phase: "loading",
      source: link,
    });
    throw new Error("timeout"); // the reply never arrived
  });
  host.handle("source.operation", () => ({ status: "completed", ticket }));
  const { window, stop } = await play(link, host);
  host.setSource({ phase: "ready" });
  await host.settle(250);
  const [submit] = host.sent("source.submit");
  assert.equal(host.sent("source.submit").length, 1);
  assert.deepEqual(host.sent("source.operation"), [
    { operationId: submit!.operationId },
  ]);
  assert.equal(window.props.status, "视频已就绪。");
  await stop();
});

test("cancel closes only its own source and the window", async () => {
  const { host, window, stop } = await play();
  const stamp = host.source.stamp;
  window.emit("cancel");
  await host.settle(250);
  assert.deepEqual(
    closes(host).map((c) => c.intent),
    [{ kind: "close", expected: stamp }],
  );
  assert.equal(host.source.phase, "empty");
  assert.equal(host.sent("ui.close").length, 1);
  // Reopening starts from a fresh window.
  await host.command("bilibili.open").run();
  assert.equal(host.window("dialog").props.status, "输入 Bilibili 视频链接。");
  assert.equal(host.window("dialog").props.busy, false);
  await stop();
});

test("a replaced request never closes the newer source", async () => {
  const { host, window, stop } = await play();
  host.openElsewhere("/other.mp4");
  await host.settle(250);
  assert.equal(window.props.status, "播放请求已被其他来源替换。");
  assert.equal(window.props.busy, false);
  window.emit("cancel");
  await host.settle(250);
  assert.equal(closes(host).length, 0);
  assert.equal(host.source.source, "/other.mp4");
  await stop();
});

test("backend media and resolution errors remain visible", async () => {
  const loading = await play();
  loading.host.setSource({
    phase: "error",
    terminalReason: { failed: "CDN denied" },
  });
  await loading.host.settle(250);
  assert.equal(loading.window.props.status, "CDN denied");
  await loading.stop();

  const host = new TestHost();
  host.handle("source.submit", () => ({
    status: "failed",
    error: { backend: "Bilibili 解析失败：HTTP 412" },
  }));
  const resolving = await play(link, host);
  assert.equal(resolving.window.props.status, "Bilibili 解析失败：HTTP 412");
  host.handle("source.submit", () => {
    throw new HostError("busy", "busy");
  });
  resolving.window.emit("play", link);
  await host.settle();
  assert.equal(resolving.window.props.status, "播放器忙，请稍后重试。");
  assert.equal(resolving.window.props.busy, false);
  await resolving.stop();
});

test("cancel while the link is still being resolved closes the pending source", async () => {
  const host = new TestHost();
  let ticket: unknown;
  host.handle("source.submit", () => {
    host.reset("source.submit"); // the close that follows uses the normal host
    host.setSource({
      stamp: { generation: 1, intentVersion: 1 },
      cycle: 1,
      phase: "loading",
      source: link,
    });
    ticket = { stamp: host.source.stamp, cycle: 1, owner: 1 };
    return { status: "pending", ticket };
  });
  host.handle("source.operation", () => ({ status: "pending", ticket })); // yt-dlp still running
  const { window, stop } = await play(link, host);
  assert.equal(window.props.status, "正在解析视频和音频…");
  window.emit("cancel");
  await host.settle(700);
  assert.equal(closes(host).length, 1);
  assert.equal(host.source.phase, "empty");
  assert.equal(window.props.status, "正在解析视频和音频…"); // a cancel is not reported as an error
  await stop();
});

test("long multi-line backend reasons are shown on one line", async () => {
  const host = new TestHost();
  host.handle("source.submit", () => ({
    status: "failed",
    error: { backend: `Bilibili 解析失败：line one\nline two ${"x".repeat(300)}` },
  }));
  const { window, stop } = await play(link, host);
  const status = String(window.props.status);
  assert.equal(status.includes("\n"), false);
  assert.ok(status.startsWith("Bilibili 解析失败：line one line two"));
  assert.equal(status.length, 160);
  await stop();
});
