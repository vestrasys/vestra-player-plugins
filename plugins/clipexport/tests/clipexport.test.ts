import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { Locale } from "@vestra-player/sdk";
import { HostError, startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate from "../main.ts";
import { Tasks } from "../tasks.ts";
import type { Task } from "../tasks.ts";
import { REASON } from "../model.ts";
import { timelineWindow } from "../clip.ts";
import { eventually, newFakes, watchHost, words } from "./fakes.ts";

const ID = "zysilm.clipexport";
/** The end of the small timeline's window around a range (the keyframe probe reads that far). */
const timelineEnd = (start: number, end: number) => timelineWindow(start, end, 600).to;

/** A job as the test host records it. */
type MediaJob = NonNullable<ReturnType<TestHost["jobs"]["get"]>>;
type Row = { id: string; name: string; state: string; reason: string; raw: string; method: string; badge: string; range: string; retryable: boolean; cancellable: boolean; openable: boolean; percent: number };

const directory = new URL("..", import.meta.url);
/** Most tests check what a Chinese user sees; English is tested on its own. */
const start = (host = new TestHost(), locale: Locale = "zh-Hans", dataDirectory?: string) => startPlugin(activate, { directory, host, locale, dataDirectory });
/** The tab's bridge values (Slint names). */
const tab = (host: TestHost) => host.mounted().props;
const rows = (host: TestHost) => tab(host).results as Row[];
/** A status line of the tab as shown. */
const statusOf = (host: TestHost, name: "clip-status" | "results-status") => words(host).status(tab(host)[name] as never);
const tick = () => new Promise((done) => setTimeout(done, 5));
/**
 * Poll an observable result. `host.settle()` waits only for host calls, not for
 * the plugin's own file-system work or timers, so assert after those this way.
 */
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1200; i++) {
    if (await predicate()) return;
    await tick();
  }
  assert.fail("timed out waiting for condition");
}
const exists = (path: string) => stat(path).then(() => true, () => false);
/** The JSON in `path` once it matches (written by a debounced, asynchronous store). */
const jsonFile = (path: string, check: (value: Record<string, unknown>) => boolean) =>
  until(() => readFile(path, "utf8").then((text) => check(JSON.parse(text)), () => false));
/** A ready finite source with snapshot support. */
function ready(host: TestHost, path = "/contract/source-one.mp4") {
  host.openElsewhere(path);
  host.setSource({ position: 2, duration: 30 });
}
/** Jobs advance only when the test says so; cancellation ends on the next read. */
function manualJobs(host: TestHost) {
  host.handle("jobs.state", (p) => {
    const job = host.jobs.get(Number(p.jobId));
    if (!job) throw new HostError("missing", "job");
    if (job.status === "cancelling") Object.assign(job, { status: "cancelled", outcome: { cancelled: true } });
    return structuredClone(job);
  });
  // The host records a job after its start request: wait for it, so a test never patches a job that is not there yet.
  return async (id: number, patch: Partial<MediaJob>) => {
    await until(() => !!host.jobs.get(id));
    Object.assign(host.jobs.get(id)!, patch);
  };
}
/** Finish job `id` as the player would: the file written, the job completed with it. */
async function complete(setJob: ReturnType<typeof manualJobs>, host: TestHost, id: number, outcome: Record<string, unknown> = {}) {
  await until(() => host.sent("jobs.start").length >= id);
  const destination = String(outcome.destination ?? host.sent("jobs.start")[id - 1]!.destination);
  await writeFile(destination, "mp4 bytes");
  await setJob(id, { status: "completed", publicationStarted: true, progress: null, outcome: { destination, ...outcome } } as never);
  return destination;
}
/** A temporary clip folder chosen through Clip Folder…. */
async function withFolder(host: TestHost) {
  const folder = await mkdtemp(join(tmpdir(), "clipexport-folder-"));
  host.dialogAnswers.push([folder]);
  await host.command("clip.folder").run();
  await until(() => host.osd.at(-1) === host.translate("Clip folder: {}", [folder])); // after the plugin's own stat of the folder
  return { folder, cleanup: () => rm(folder, { recursive: true, force: true }) };
}
const TRACKS = [
  { trackId: 7, selected: true, external: false, streamIndex: 1, codec: "aac", title: null, language: "en" },
  { trackId: 8, selected: false, external: false, streamIndex: 2, codec: "opus", title: null, language: null },
];
/** Export the range typed into the tab and wait for the export to start. */
async function exportTyped(host: TestHost, from: string, to: string, count: number) {
  host.mounted().emit("export-clip", from, to);
  await until(() => host.sent("jobs.start").length === count);
}

test("one menu item, Video ▸ Export Clip…; the rest is in the command palette with its keys; one sidebar tab", async () => {
  const host = new TestHost();
  ready(host);
  const { stop } = await start(host);
  try {
    const menu = [...host.commands.entries()].filter(([, c]) => c.declaration.path?.length).map(([id, { declaration: d }]) => [id, d.path, d.order, d.group, d.bindings.join(",")]);
    assert.deepEqual(menu, [["clip.open", ["@video", "Export Clip…"], 470, "clip-export", ""]]);
    assert.equal(host.command("clip.open").display.path.at(-1), "导出片段…");
    const palette = [...host.commands.entries()].filter(([, c]) => !c.declaration.path?.length).map(([id, { declaration: d }]) => [id, d.bindings.join(","), d.home ?? ""]);
    assert.deepEqual(palette, [
      ["clip.export", "Ctrl+Shift+E", "clip.panel"],
      ["clip.panel", "", ""],
      ["clip.tasks", "", ""],
      ["clip.settings", "", ""],
      ["clip.folder", "", "clip.settings"],
      ["clip.openFolder", "", ""],
      ["clip.revealLast", "", "clip.tasks"],
      ["clip.start", "", "clip.panel"],
      ["clip.end", "", "clip.panel"],
      ["clip.collectionAdd", "", "clip.collection"],
      ["clip.collection", "", ""],
      ["clip.collectionExport", "", "clip.collection"],
      ["clip.collectionClear", "", "clip.collection"],
      ["clip.collectionUndo", "", "clip.collection"],
      ["clip.collectionUndoApply", "", "clip.collection"],
      ["clip.collectionRemove", "Delete", "clip.collection"],
      ["clip.highlights", "", "clip.panel"],
      ["clip.highlightAdd", "Enter", "clip.highlights"],
      ["clip.highlightDismiss", "", "clip.highlights"],
      ["clip.highlightsShow", "", "clip.highlights"],
      ["clip.last", "Ctrl+Shift+R", "clip.panel"],
    ]);
    assert.deepEqual(host.conflicts, []);
    assert.equal(host.sent("ui.open").length, 0, "no windows");
    assert.equal(host.mounted().slot, "sidebar");
    assert.equal(host.mounted().component, "ClipExportTab");
    assert.equal(host.layout.sidebar?.panels?.[0]?.title, "片段导出");
    assert.equal(host.sent("ui.bottom").length, 0, "no bottom-bar button of its own");
    assert.ok([...host.commands.values()].every((c) => !(c.declaration as { button?: unknown }).button), "no command button in the bottom bar");
  } finally {
    await stop();
  }
});

test("every command has the Export category in the command palette, and every home is one of its commands", async () => {
  for (const locale of ["en", "zh-Hans"] as const) {
    const host = new TestHost();
    ready(host);
    const { stop } = await start(host, locale);
    try {
      assert.equal(host.commands.size, 22);
      for (const [id, command] of host.commands) {
        assert.equal(command.declaration.category, "Export", id);
        assert.ok(command.display.category?.trim(), `${id}: shows a category in ${locale}`);
        assert.ok((command.display.path.at(-1) ?? command.display.title ?? "").trim(), `${id}: has a title`);
        const { home } = command.declaration;
        if (home !== undefined) assert.ok(host.commands.has(home), `${id}: home ${home} is a command of this plugin`);
      }
      if (locale === "en") assert.equal(host.command("clip.export").display.category, "Export");
    } finally {
      await stop();
    }
  }
});

test("English by default: menus, the tab's title, OSD and the clip's dialog are the English source texts", async () => {
  const host = new TestHost();
  ready(host);
  host.setSource({ audioTracks: TRACKS });
  const { stop } = await start(host, "en");
  try {
    assert.deepEqual(host.command("clip.open").display.path.at(-1), "Export Clip…");
    assert.equal(host.command("clip.last").display.title, "Export Last 30 Seconds");
    assert.equal(host.layout.sidebar?.panels?.[0]?.title, "Clip Export");
    await eventually(() => tab(host)["audio-labels"], ["No Audio", "Current Track", "Track 7 · en", "Track 8"]);
    host.dialogAnswers.push(null);
    host.mounted().emit("set-method", 1);
    host.mounted().emit("export-as", "1", "4");
    await until(() => statusOf(host, "clip-status") === "No save location chosen.");
    assert.equal(host.sent("dialogs.open").at(-1)!.title, "Export Clip");
    assert.equal(host.sent("dialogs.open").at(-1)!.fileName, "source-one_00.01.000-00.04.000.mp4", "{name}_{start}-{end}");
    host.mounted().emit("export-clip", "5", "1");
    await until(() => statusOf(host, "clip-status") === REASON.endBeforeStart);
    await eventually(() => tab(host)["clip-status"], { kind: "error", reason: "endBeforeStart", raw: "", name: "" }, "data, not words");
  } finally {
    await stop();
  }
});

test("the reasons in model.ts and Words.reason in ui/parts.slint are the same texts; all six languages are translated", async () => {
  const slint = await readFile(new URL("../ui/parts.slint", import.meta.url), "utf8");
  const said = Object.fromEntries([...slint.matchAll(/code == "(\w+)"\) \{ return @tr\("([^"]+)"\)/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(said, { ...REASON });
  for (const locale of ["zh-Hans", "de", "es", "fr", "ja", "ko"]) {
    const po = await readFile(new URL(`../locales/${locale}.po`, import.meta.url), "utf8");
    assert.doesNotMatch(po.replace(/^msgid ""\nmsgstr ""\n/, ""), /msgstr ""\n\n/, `${locale}: every text translated`);
  }
  const { host, stop } = await start();
  const { reason, status, state } = words(host);
  assert.equal(reason("space", ""), "磁盘空间不足");
  assert.equal(reason("", "a message of the player"), "a message of the player");
  assert.equal(state("running"), "导出中");
  assert.equal(status({ kind: "clip-failed", reason: "space", raw: "", name: "" }), "导出失败：磁盘空间不足");
  await stop();
});

test("the tab's Slint: a ListView for Results, library widgets, key caps, Theme tokens, every label in @tr", async () => {
  const slint = await readFile(new URL("../ui/tab.slint", import.meta.url), "utf8");
  const parts = await readFile(new URL("../ui/parts.slint", import.meta.url), "utf8");
  assert.match(slint, /ListView \{\s*vertical-stretch: 1;\s*for row in ClipBridge\.results: ResultItem/);
  // Real pages: four persistent pages (Clip, Highlights, Results, Settings), one shown, switched with `visible`.
  for (const page of [0, 1, 2, 3]) assert.equal(slint.split(`visible: ClipBridge.page == ${page};`).length - 1, 1, `page ${page}`);
  assert.equal(slint.split("visible: ClipBridge.page == 4;").length, 1, "no fifth page");
  // The sub-tabs: the library's Tab, one per page, selected by the page shown, each as wide as its label (the Tabs strip's 74 px minimum does not fit four in 280 px).
  for (const page of [0, 1, 2, 3]) assert.equal(slint.split(`selected: ClipBridge.page == ${page};`).length - 1, 1, `tab ${page}`);
  assert.equal(slint.split("min-width: measure-").length - 1, 3, "three tabs at their labels' width");
  assert.match(slint, /min-width: min\(measure-highlights\.preferred-width \+ 12px, 44px\);/, "Highlights gives way first");
  // No wrapped text: a wrapped line is laid out one line tall and overlapped the rows below it.
  assert.doesNotMatch(slint, /wrap:\s*word-wrap/);
  // One scroll set by the tab: Show Collection brings the list into view (and only when asked).
  assert.doesNotMatch(slint, /jump-/);
  assert.equal(slint.split("viewport-y =").length - 1, 1);
  assert.match(slint, /changed list-request => \{\s*clip-page\.viewport-y = /);
  assert.doesNotMatch(slint, /ComboBox|CheckBox|StandardListView/);
  assert.match(slint, /import \{ Button, Check, Choice, KeyHint, RadioGroup, Slider, Tab, ToolTipArea, ToolTipKey \} from "@vestra\/widgets\.slint";/);
  assert.match(slint, /KeyHint \{ text: root\.key; \}/);
  assert.match(slint, /tip-keys: \[\{ key: ClipBridge\.keys\.clip, text: "" \}\]/);
  assert.doesNotMatch(slint, /snapshot|burst|camera/i, "nothing of the snapshot part");
  for (const [name, text] of [["tab", slint], ["parts", parts]] as const) {
    assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b/i, `${name}: colours come from Theme`);
    assert.doesNotMatch(text, /font-size:\s*\d/, `${name}: font sizes come from Theme`);
    assert.doesNotMatch(text, /(text|title|tip|label|detail|summary):\s*"[^"]*[a-z]{3,}[^"]*"/, `${name}: every label in @tr`);
  }
  // A `for` over bound data only inside the ListView.
  const loops = [...slint.matchAll(/for \w+(?:\[\w+\])? in ([\w.-]+|\[[^\]]*\])/g)].map((m) => m[1]);
  assert.deepEqual(loops.filter((what) => !what!.startsWith("[")), ["ClipBridge.highlight-rows", "ClipBridge.parts", "ClipBridge.results"]);
  assert.match(slint, /ListView \{[^{}]*for row\[i\] in ClipBridge\.parts: PartItem/, "the Collection is a ListView too");
  assert.match(slint, /ListView \{[^{}]*for row in ClipBridge\.highlight-rows: HighlightItem/, "the suggestions are a ListView too");
  // The bridge's callbacks are the ones the plugin handles: each emitted callback reaches main.ts.
  const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");
  const camel = (name: string) => name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  const handled = new Set([...main.matchAll(/\b(?:on|onRow|onPart)\("(\w+)"/g)].map((m) => m[1]));
  const bridge = slint.slice(slint.indexOf("export global ClipBridge"), slint.indexOf("// Glyphs of this tab"));
  const declared = [...bridge.matchAll(/callback ([\w-]+)\(/g)].map((m) => camel(m[1]!));
  assert.deepEqual(declared.filter((name) => !handled.has(name)), [], "every bridge callback has a handler");
  assert.deepEqual([...handled].filter((name) => !declared.includes(name!)), [], "every handler has a bridge callback");
});

test("the chosen clip folder and the tab's choices are kept in the data directory and restored on the next start", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-")); // outlives each test host, like the player's
  const host = new TestHost();
  ready(host);
  const first = await start(host, "zh-Hans", data);
  const { folder, cleanup } = await withFolder(host);
  try {
    host.mounted().emit("set-advanced-open", true);
    host.mounted().emit("template-edited", "{name}-{n}");
    host.mounted().emit("set-last-seconds", 2);
    host.mounted().emit("set-method", 1);
    host.mounted().emit("set-preset", 2);
    await host.settle();
    await jsonFile(join(data, "settings.json"), (v) => v.folder === folder && v.advancedOpen === true && v.lastSeconds === 60 && v.template === "{name}-{n}" && v.method === "precise");
    await first.stop();
    const restart = new TestHost();
    ready(restart);
    const second = await startPlugin(activate, { directory, host: restart, dataDirectory: data, locale: "en" });
    await restart.settle();
    await eventually(() => tab(restart).folder, folder);
    await eventually(() => tab(restart)["advanced-open"], true);
    await eventually(() => tab(restart).template, "{name}-{n}");
    await eventually(() => tab(restart)["last-index"], 2);
    await eventually(() => [tab(restart)["method-index"], tab(restart)["preset-index"]], [1, 2]);
    assert.equal(restart.command("clip.last").display.title, "Export Last 60 Seconds");
    await second.stop();
    await rm(folder, { recursive: true, force: true }); // a removed folder falls back to the default
    const third = await startPlugin(activate, { directory, host: new TestHost(), dataDirectory: data });
    await third.host.settle();
    assert.notEqual(tab(third.host).folder, folder);
    await third.stop();
  } finally {
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("a damaged settings.json is set aside as .bad-<time>; a partly invalid one falls back field by field", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const folder = await mkdtemp(join(tmpdir(), "clipexport-folder-"));
  try {
    await writeFile(join(data, "settings.json"), "{ broken");
    let started = await startPlugin(activate, { directory, host: new TestHost(), dataDirectory: data });
    await started.host.settle();
    assert.equal(tab(started.host)["method-index"], 0, "Fast");
    await started.stop();
    assert.ok((await readdir(data)).some((name) => /^settings\.json\.bad-\d+$/.test(name)));
    await writeFile(join(data, "settings.json"), JSON.stringify({ folder, method: "turbo", lastSeconds: 250, besideMedia: true }));
    started = await startPlugin(activate, { directory, host: new TestHost(), dataDirectory: data });
    const { host } = started;
    await host.settle();
    const props = tab(host);
    assert.deepEqual([props.folder, props["method-index"], props["last-seconds"], props["beside-media"]], [folder, 0, 30, true]);
    await started.stop();
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  }
});

const EXPORTS = ["clip.export", "clip.start", "clip.end", "clip.last"];

test("lazy activation: the export commands are player conditions; a background tab keeps nothing running and reads no player state", async () => {
  const host = new TestHost();
  host.mountOther("sidebar", "vestra.playlist", { title: "Playlist" }); // the playlist's tab is first and current, as in the player
  const { stop } = await start(host);
  try {
    await host.settle();
    assert.deepEqual(host.keepsRunning, []);
    assert.equal(host.listening.has("source.state"), false);
    for (const id of EXPORTS)
      assert.deepEqual(host.command(id).when, { enabled: { all: [{ can: "snapshot" }, { phase: ["ready", "ended"] }, { not: { kind: "stream" } }] } }, id);
    assert.deepEqual(EXPORTS.map((id) => host.command(id).state.enabled), EXPORTS.map(() => false));
    assert.equal(host.translate(host.command("clip.export").state.reason!), "没有可导出的内容");
    assert.equal(await host.press("Ctrl+Shift+E"), "reason");
    ready(host);
    await host.settle();
    assert.deepEqual(EXPORTS.map((id) => host.command(id).state.enabled), EXPORTS.map(() => true));
    assert.deepEqual(host.keepsRunning, []);
    assert.equal(host.listening.has("source.state"), false, "the background tab does not follow playback");
    await eventually(() => tab(host).mode, undefined, "nothing of the player's state was sent");
    // The user shows the tab: it reads the player's state now, and follows it.
    host.selectTab(ID);
    await host.settle();
    await eventually(() => tab(host).mode, "local");
    await eventually(() => tab(host)["can-clip"], true);
    assert.equal(host.listening.has("source.state"), true);
    host.setSource({ phase: "loading" });
    await host.settle();
    await eventually(() => tab(host).mode, "none", "followed while it shows");
    host.selectTab("vestra.playlist");
    // The layout is read after the event; the binding then runs again without reading the player's state.
    await until(() => !host.listening.has("source.state"));
    assert.deepEqual(host.keepsRunning, []);
  } finally {
    await stop();
  }
});

test("tab states: no media, a plugin's stream, a network source, a local file", async () => {
  const host = new TestHost();
  const { stop } = await start(host, "en");
  try {
    await host.settle();
    await eventually(() => [tab(host).mode, tab(host)["can-clip"]], ["none", false]);
    host.openElsewhere("https://example.test/live.m3u8");
    host.setSource({ position: 2, duration: 30 });
    await host.settle();
    await eventually(() => [tab(host).mode, tab(host)["can-clip"], tab(host)["can-last"]], ["network", false, false]);
    host.setSource({ kind: "producer", phase: "ready" });
    await host.settle();
    await eventually(() => [tab(host).mode, tab(host)["can-clip"]], ["stream", false]);
    ready(host);
    host.setSource({ kind: "media" });
    await host.settle();
    await eventually(() => [tab(host).mode, tab(host)["can-clip"], tab(host)["can-last"]], ["local", true, true]);
  } finally {
    await stop();
  }
});

test("Export As asks for a file; a source change while it is open exports nothing", async () => {
  const host = new TestHost();
  ready(host);
  const { stop } = await start(host);
  const folder = await mkdtemp(join(tmpdir(), "clipexport-as-"));
  try {
    host.handle("dialogs.open", () => {
      host.openElsewhere("/contract/other.mp4");
      host.setSource({ position: 2, duration: 30 });
      return { cancelled: false, paths: [join(folder, "a.mp4")] };
    });
    host.mounted().emit("export-as", "1", "4");
    await until(() => statusOf(host, "clip-status") === "播放内容已变化，未开始。");
    assert.equal(host.sent("snapshot.capture").length, 0);
    host.reset("dialogs.open");
    host.mounted().emit("set-method", 1);
    host.dialogAnswers.push([join(folder, "named")]);
    host.mounted().emit("export-as", "1", "4");
    await until(() => host.sent("jobs.start").length === 1);
    assert.equal(host.sent("snapshot.capture")[0]!.time, 1);
    assert.equal(host.sent("jobs.start")[0]!.destination, join(folder, "named.mp4"), "the extension is added");
  } finally {
    await stop();
    await rm(folder, { recursive: true, force: true });
  }
});

test("Precise: Export saves into the folder with the template's name and the tab's encoder settings (R6); progress (R4), the range written (R2), OSD buttons (R5)", async () => {
  const host = new TestHost();
  ready(host);
  host.setSource({ audioTracks: TRACKS });
  const setJob = manualJobs(host);
  const { stop } = await start(host);
  const { folder, cleanup } = await withFolder(host);
  try {
    const panel = host.mounted();
    await eventually(() => tab(host)["audio-labels"], ["无声音", "当前音轨", "音轨 7 · en", "音轨 8"]);
    panel.emit("set-method", 1);
    panel.emit("set-preset", 2);
    panel.emit("set-audio", 2);
    panel.emit("set-processed", true);
    panel.emit("clip-edited", "0:01", "0:04.5");
    await host.settle();
    await eventually(() => tab(host)["clip-name"], "source-one_00.01.000-00.04.500.mp4", "the name the Export button gives");
    await eventually(() => tab(host)["field-error"], "");
    await eventually(() => (tab(host).estimate as { length: string }).length, "3.5");
    await eventually(() => (tab(host).note as { method: string }).method, "precise");
    await eventually(() => tab(host)["preset-index"], 2, "Small file");
    panel.emit("export-clip", "0:01", "0:04.5");
    await until(() => host.sent("jobs.start").length === 1 && statusOf(host, "clip-status") === "已开始导出，可在结果中查看。");
    assert.equal(host.sent("dialogs.open").length, 1, "only the folder dialog: Export asks for nothing");
    const capture = host.sent("snapshot.capture")[0]!;
    assert.deepEqual(capture.expected, host.source.stamp);
    assert.deepEqual([capture.mode, capture.time, capture.includeSubtitles], ["processed", 1, false]);
    assert.deepEqual(capture.audio, { kind: "track", trackId: 7 });
    const job = host.sent("jobs.start")[0]!;
    assert.deepEqual([job.kind, job.end, job.destination], ["processedMp4", 4.5, join(folder, "source-one_00.01.000-00.04.500.mp4")]);
    assert.deepEqual(job.encoding, { crf: 26, speed: "balanced", maxHeight: 1080, audioBitrate: 128, threads: "auto" });
    // The progress card and the row while it runs.
    await until(() => (tab(host).card as { shown: boolean }).shown);
    await eventually(() => (tab(host).card as { name: string }).name, "source-one_00.01.000-00.04.500.mp4");
    await eventually(() => (tab(host).card as { percent: number }).percent, -1, "no percentage before the first progress");
    await setJob(1, { status: "running", progress: { done: 1.75, total: 3.5 } } as never);
    await until(() => (tab(host).card as { percent: number }).percent === 50 && rows(host)[0]?.state === "running" && rows(host)[0]!.percent === 50);
    const destination = await complete(setJob, host, 1, { start: 1, end: 4.52 });
    await until(() => host.osd.at(-1) === `片段已导出为 ${destination}` && statusOf(host, "clip-status") === "已导出 source-one_00.01.000-00.04.500.mp4");
    await until(() => rows(host).length === 1 && rows(host)[0]!.state === "completed");
    await eventually(() => (tab(host).card as { shown: boolean }).shown, false);
    await eventually(() => [rows(host)[0]!.method, rows(host)[0]!.badge], ["precise", "3.5"]);
    await eventually(() => rows(host)[0]!.range, "00:01.000–00:04.520", "R2: the range the file holds");
    // R5: the message's buttons, and what they do.
    assert.deepEqual(host.osdActions.at(-1), [{ title: "在文件夹中显示", command: "clip.revealLast" }, { title: "在页签中显示", command: "clip.tasks" }]);
    await host.pressOsdAction(0);
    await until(() => host.system.revealed.length === 1);
    assert.deepEqual(host.system.revealed, [destination]);
    host.mounted().emit("reveal-result", rows(host)[0]!.id);
    await until(() => host.system.revealed.length === 2);
    await host.pressOsdAction(1);
    await host.settle();
    await eventually(() => tab(host).page, 2, "Show in Tab: the Results page");
  } finally {
    await stop();
    await cleanup();
  }
});

test("Export Clip… only opens the Clip page; Export Clip Range (Ctrl+Shift+E) exports, or opens it when there is no range", async () => {
  const host = new TestHost();
  ready(host);
  host.mountOther("sidebar", "vestra.playlist", { title: "Playlist" });
  const setJob = manualJobs(host);
  const { stop } = await start(host);
  const { cleanup } = await withFolder(host);
  try {
    await host.settle();
    await eventually(() => (tab(host).keys as { clip: string }).clip, "⇧⌘E", "the Export button shows Export Clip Range's key");
    // No range yet: the key opens the Clip page with the position → +10 s, and exports nothing.
    host.mounted().emit("set-page", 2);
    await host.press("Ctrl+Shift+E");
    await host.settle();
    assert.equal(host.layout.sidebar?.owner, 1, "the tab is in front");
    await eventually(() => [tab(host)["clip-start"], tab(host)["clip-end"]], ["00:02.000", "00:12.000"]);
    await eventually(() => tab(host).page, 0, "the Clip page");
    assert.equal(host.sent("jobs.start").length, 0);
    // Export Clip… never exports, also while the tab shows.
    await host.command("clip.open").run();
    await host.settle();
    assert.equal(host.sent("jobs.start").length, 0);
    // With a range, the key exports it.
    await host.press("Ctrl+Shift+E");
    await until(() => host.sent("jobs.start").length === 1);
    assert.equal(host.sent("jobs.start")[0]!.end, 12);
    await setJob(1, { status: "cancelled", outcome: { cancelled: true } });
    // A range the user typed: Export Clip… keeps it; a bad one is said on screen by the key.
    host.mounted().emit("clip-edited", "0:05", "0:03");
    const sets = host.sent("ui.setMount").length;
    await host.command("clip.open").run();
    await host.settle();
    assert.ok(host.sent("ui.setMount").length > sets && host.sent("ui.setMount").slice(sets).every((p) => !/clip-?start/i.test(JSON.stringify(p))), "nothing written over the typed fields");
    await host.press("Ctrl+Shift+E");
    await until(() => host.osd.at(-1) === "导出失败：结束时间必须晚于开始时间。");
  } finally {
    await stop();
    await cleanup();
  }
});

test("field errors: a time that is none, an end before the start; Export is refused with the reason", async () => {
  const host = new TestHost();
  ready(host);
  const { stop } = await start(host);
  try {
    const panel = host.mounted();
    panel.emit("clip-edited", "1:7x", "4");
    await host.settle();
    await eventually(() => [tab(host)["field-error"], tab(host)["error-field"]], ["time", "start"]);
    panel.emit("clip-edited", "0:05", "0:04");
    await host.settle();
    await eventually(() => [tab(host)["field-error"], tab(host)["error-field"]], ["endBeforeStart", "end"]);
    await eventually(() => tab(host)["clip-name"], "");
    panel.emit("export-clip", "0:05", "0:04");
    await until(() => statusOf(host, "clip-status") === "结束时间必须晚于开始时间。");
    assert.equal(host.sent("snapshot.capture").length, 0);
  } finally {
    await stop();
  }
});

test("Use A-B range copies the loop once; without a loop it says how to set one", async () => {
  const host = new TestHost();
  ready(host);
  const { stop } = await start(host);
  try {
    await host.settle();
    await eventually(() => tab(host).ab, { shown: false, a: "", b: "" });
    host.mounted().emit("use-ab");
    await until(() => statusOf(host, "clip-status") === words(host).reason("noLoop", ""));
    host.setSource({ loop: { a: 3.5, b: 9.25, count: null } });
    await host.settle();
    await eventually(() => tab(host).ab, { shown: true, a: "00:03.500", b: "00:09.250" });
    host.mounted().emit("use-ab");
    await host.settle();
    await eventually(() => [tab(host)["clip-start"], tab(host)["clip-end"]], ["00:03.500", "00:09.250"]);
    host.setSource({ loop: { a: 1, b: 2, count: null } });
    await host.settle();
    await eventually(() => [tab(host)["clip-start"], tab(host)["clip-end"]], ["00:03.500", "00:09.250"], "a copy, not a link");
  } finally {
    await stop();
  }
});

test("Last N s (Ctrl+Shift+R): the seconds before the position into the folder; the length is adjustable and names the command", async () => {
  const host = new TestHost();
  ready(host);
  host.setSource({ position: 20 });
  const setJob = manualJobs(host);
  const { stop } = await start(host, "en");
  const { cleanup } = await withFolder(host);
  try {
    host.rebind("clip.last", ["Ctrl+Alt+L"]);
    await assert.rejects(host.press("Ctrl+Shift+R"), /nothing is bound/, "the user's key replaced the default");
    await host.press("Ctrl+Alt+L");
    await until(() => host.sent("jobs.start").length === 1);
    assert.equal(host.sent("snapshot.capture")[0]!.time, 0, "max(0, 20 − 30)");
    assert.equal(host.sent("jobs.start")[0]!.end, 20);
    assert.equal(host.osd.at(-1), "Exporting the last 30 seconds");
    await eventually(() => [tab(host)["clip-start"], tab(host)["clip-end"]], ["00:00.000", "00:20.000"], "empty fields show what was exported");
    await setJob(1, { status: "cancelled", outcome: { cancelled: true } });
    // A range the user typed is kept; Last N s exports its own range all the same.
    host.mounted().emit("clip-edited", "0:03", "0:07");
    host.setSource({ position: 25 });
    host.mounted().emit("last");
    await until(() => host.sent("jobs.start").length === 2);
    assert.deepEqual([host.sent("snapshot.capture")[1]!.time, host.sent("jobs.start")[1]!.end], [0, 25]);
    await eventually(() => tab(host)["clip-end"], "00:20.000", "the typed fields were not written over (00:25.000 would be)");
    host.setSource({ position: 20 });
    await setJob(2, { status: "cancelled", outcome: { cancelled: true } });
    host.mounted().emit("clip-edited", "", "");
    host.mounted().emit("set-last-seconds", 0);
    await host.settle();
    assert.equal(host.command("clip.last").display.title, "Export Last 10 Seconds");
    assert.deepEqual(host.command("clip.last").declaration.bindings, ["Ctrl+Shift+R"]);
    host.mounted().emit("last");
    await until(() => host.sent("jobs.start").length === 3);
    assert.equal(host.sent("snapshot.capture")[2]!.time, 10);
    // Too little played: refused with a reason.
    host.setSource({ position: 0.05 });
    host.mounted().emit("last");
    await until(() => host.osd.at(-1) === `Export failed: ${REASON.tooEarly}`);
  } finally {
    await stop();
    await cleanup();
  }
});

test("the clip guard is taken before the first await; a rejected source releases it", async () => {
  const { host, stop } = await start();
  const panel = host.mounted();
  const reads = host.sent("source.state").length;
  panel.emit("export-clip", "0", "1");
  panel.emit("export-clip", "0", "1");
  await host.settle();
  assert.equal(host.sent("source.state").length - reads, 1, "duplicate entry excluded before the source read");
  assert.equal(statusOf(host, "clip-status"), "没有可导出的内容，请先打开本地视频文件。");
  await eventually(() => tab(host)["clip-busy"], false);
  panel.emit("export-clip", "0", "1");
  await host.settle();
  assert.equal(host.sent("source.state").length - reads, 2, "guard released after rejection");
  assert.equal(host.sent("dialogs.open").length, 0);
  await stop();
});

test("one running and four queued; the sixth is refused; queued input keeps its source; cancel from Results", async () => {
  const host = new TestHost();
  ready(host);
  const setJob = manualJobs(host);
  const { stop } = await start(host);
  const { folder, cleanup } = await withFolder(host);
  try {
    for (let i = 1; i <= 5; i++) {
      host.mounted().emit("export-clip", "0:01", "0:04");
      await until(() => host.sent("snapshot.capture").length === i && tasksShown(host) === i);
    }
    assert.equal(host.sent("jobs.start").length, 1, "only one accepted task starts its job");
    await host.settle();
    await eventually(() => tab(host)["queue-full"], true);
    await eventually(() => (tab(host).card as { queued: number }).queued, 4);
    host.mounted().emit("export-clip", "0:01", "0:04");
    await until(() => statusOf(host, "clip-status") === "已有一个导出在进行、四个在排队，请稍候。");
    assert.equal(host.sent("snapshot.capture").length, 5, "the sixth entry freezes nothing");
    host.mounted().emit("cancel-task", "t2");
    await until(() => rows(host).some((row) => row.id === "t2" && row.state === "cancelled"));
    assert.equal(host.sent("jobs.cancel").length, 0, "queued cancellation leaves the running job alone");
    host.openElsewhere("/contract/source-two.mp4");
    await complete(setJob, host, 1);
    await until(() => host.sent("jobs.start").length === 2);
    assert.equal(host.sent("jobs.start")[1]!.snapshotId, 3, "skips the cancelled task and uses the third frozen input");
    assert.equal((host.snapshots.get(3) as { sourceStamp: { generation: number } }).sourceStamp.generation, 1, "queued input not refreshed");
    assert.equal(host.snapshots.has(1), false, "a completed task releases its input");
    await until(() => rows(host).some((row) => row.id.startsWith("r") && row.name === "source-one_00.01.000-00.04.000.mp4"));
    await eventually(() => rows(host).some((row) => row.name === "source-one_00.01.000-00.04.000 (2).mp4"), true, "queued clips never share a name");
    host.mounted().emit("cancel-task", "t3");
    await until(() => rows(host).some((row) => row.id === "t3" && row.state === "cancelled"));
    assert.equal(host.sent("jobs.cancel").length, 1, "the active job is cancelled");
    await eventually(() => rows(host).find((row) => row.id === "t3")!.retryable, true);
    host.mounted().emit("remove-result", "t3");
    await until(() => !rows(host).some((row) => row.id === "t3"));
    assert.ok(await exists(folder));
  } finally {
    await stop();
    await cleanup();
  }
});
/** Task rows in Results. */
const tasksShown = (host: TestHost) => rows(host).filter((row) => row.id.startsWith("t")).length;

test("a failed task keeps its input; retry from Results reuses it after the source changed", async () => {
  const host = new TestHost();
  ready(host);
  const setJob = manualJobs(host);
  const { stop } = await start(host);
  const { folder, cleanup } = await withFolder(host);
  try {
    await exportTyped(host, "0:01", "0:04", 1);
    await setJob(1, { status: "failed", outcome: { error: { code: "space", message: "disk full" } } });
    await until(() => host.osd.at(-1) === "导出失败：磁盘空间不足");
    await until(() => rows(host)[0]?.state === "failed");
    await eventually(() => [rows(host)[0]!.reason, rows(host)[0]!.retryable], ["space", true]);
    host.openElsewhere("/contract/source-two.mp4");
    host.mounted().emit("retry-task", "t1");
    await until(() => host.sent("jobs.start").length === 2 && statusOf(host, "results-status") === "已重新开始。");
    assert.equal(host.sent("snapshot.capture").length, 1, "no new snapshot");
    assert.equal(host.sent("jobs.start")[1]!.snapshotId, 1);
    assert.equal(host.sent("jobs.start")[1]!.destination, join(folder, "source-one_00.01.000-00.04.000 (1).mp4"));
    await until(() => !rows(host).some((row) => row.id === "t1"));
  } finally {
    await stop();
    await cleanup();
  }
});

test("when the tab cannot be shown, its commands say so on screen; the keys keep working", async () => {
  const host = new TestHost();
  ready(host);
  const { stop } = await start(host);
  const { cleanup } = await withFolder(host);
  try {
    host.mounted().emit("clip-edited", "0:01", "0:04");
    host.handle("layout.set", () => {
      throw new HostError("unavailable", "no interface");
    });
    await host.command("clip.tasks").run();
    await until(() => host.osd.at(-1) === "无法打开“片段导出”页签。");
    await host.press("Ctrl+Shift+E");
    await until(() => host.sent("jobs.start").length === 1);
  } finally {
    await stop();
    await cleanup();
  }
});

test("typed times survive other actions; Now writes only its own field", async () => {
  const host = new TestHost();
  ready(host);
  const { stop } = await start(host);
  try {
    host.mounted().emit("clip-edited", "5", "9");
    host.mounted().emit("clip-now", "end");
    await host.settle();
    await eventually(() => tab(host)["clip-end"], "00:02.000");
    await eventually(() => tab(host)["clip-start"], "5", "what the user typed");
    await host.command("clip.start").run();
    await host.settle();
    await eventually(() => tab(host)["clip-start"], "00:02.000");
    assert.equal(host.osd.at(-1), "片段起点：00:02.000");
  } finally {
    await stop();
  }
});

test("the typed fields survive standby (session storage)", async () => {
  const host = new TestHost();
  ready(host);
  const first = await start(host);
  host.mounted().emit("clip-edited", "0:07", "0:11");
  host.mounted().emit("set-audio", 0);
  await until(() => !!host.sessionStorage.get("form"));
  const kept = host.sessionStorage.get("form");
  assert.deepEqual([(kept as { start: string }).start, (kept as { audioIndex: number }).audioIndex], ["0:07", 0]);
  await first.stop();
  const again = new TestHost();
  ready(again);
  const second = await startPlugin(activate, { directory, host: again, locale: "zh-Hans", sessionStorage: new Map([["form", kept!]]) });
  // The fields come back with `set`, the audio choice with the binding: wait for all three.
  await until(() => tab(again)["clip-start"] === "0:07" && tab(again)["clip-end"] === "0:11" && tab(again)["audio-index"] === 0);
  await second.stop();
});

test("Clip Export Tab toggles the tab and is checked while it is in front; it has no default key", async () => {
  const host = new TestHost();
  ready(host);
  host.mountOther("sidebar", "vestra.playlist", { title: "Playlist" });
  const { stop } = await start(host);
  try {
    const toggle = host.command("clip.panel");
    assert.deepEqual(toggle.declaration.bindings, []);
    assert.equal(toggle.state.checked, false);
    await toggle.run();
    await host.settle();
    assert.equal(host.layout.sidebar?.owner, 1);
    assert.equal(toggle.state.checked, true);
    await toggle.run();
    await host.settle();
    assert.equal(host.layout.sidebar?.preferred, false, "run again with the tab in front: the sidebar hides");
  } finally {
    await stop();
  }
});

test("key caps follow the user's keys (commands.keys)", async () => {
  const host = new TestHost();
  host.systemInfo.os = "windows";
  ready(host);
  const { stop } = await start(host);
  try {
    await host.settle();
    await eventually(() => tab(host).keys, { clip: "Ctrl+Shift+E", last: "Ctrl+Shift+R", panel: "", start: "", end: "", add: "", merge: "", remove: "Del", highlights: "" });
    // Set Clip Start / End and Add have no default keys (design question Q1); a key the user binds shows on their buttons.
    host.rebind("clip.start", ["Alt+I"]);
    await until(() => (tab(host).keys as { start: string }).start === "Alt+I");
    host.rebind("clip.panel", ["Alt+X"]);
    host.rebind("clip.export", []);
    await until(() => (tab(host).keys as { panel: string }).panel === "Alt+X");
    await eventually(() => (tab(host).keys as { clip: string }).clip, "", "a cleared key shows no cap");
  } finally {
    await stop();
  }
});

test("results persist across restarts (finished only); a moved file says so; Clear Finished empties the list", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  ready(host);
  const setJob = manualJobs(host);
  const first = await start(host, "zh-Hans", data);
  const { cleanup } = await withFolder(host);
  try {
    await exportTyped(host, "0:01", "0:04", 1);
    const destination = await complete(setJob, host, 1);
    await until(() => rows(host).length === 1 && rows(host)[0]!.state === "completed");
    await exportTyped(host, "0:05", "0:09", 2);
    await setJob(2, { status: "failed", outcome: { error: { code: "space", message: "full" } } });
    await until(() => rows(host).length === 2);
    await jsonFile(join(data, "results.json"), (v) => (v.list as unknown[]).length === 1);
    await first.stop();
    const again = new TestHost();
    const second = await startPlugin(activate, { directory, host: again, dataDirectory: data, locale: "zh-Hans" });
    await until(() => rows(again).length === 1);
    await eventually(() => [rows(again)[0]!.name, rows(again)[0]!.state], [basename(destination), "completed"], "the failed task stayed in its session");
    await second.stop();
    await rm(destination);
    const third = new TestHost();
    const after = await startPlugin(activate, { directory, host: third, dataDirectory: data, locale: "zh-Hans" });
    await until(() => rows(third)[0]?.state === "gone");
    await eventually(() => rows(third)[0]!.openable, false);
    third.mounted().emit("clear-finished");
    await until(() => rows(third).length === 0);
    await after.stop();
  } finally {
    await cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test("Results: Open opens the clip with system.openPath; Open Clip Folder the folder, beside the media when chosen; a moved file says so", async () => {
  const fakes = newFakes();
  const media = await mkdtemp(join(tmpdir(), "clipexport-media-"));
  const host = new TestHost();
  watchHost(host, fakes);
  ready(host, join(media, "movie.mp4"));
  const setJob = manualJobs(host);
  const { stop } = await start(host);
  const { folder, cleanup } = await withFolder(host);
  try {
    host.mounted().emit("set-method", 1);
    await exportTyped(host, "0:01", "0:04", 1);
    const destination = await complete(setJob, host, 1);
    await until(() => rows(host)[0]?.state === "completed");
    const clip = rows(host)[0]!.id;
    host.mounted().emit("open-result", clip);
    await until(() => fakes.opened.length === 1);
    assert.deepEqual(fakes.opened, [destination]);
    fakes.failOpen = true;
    host.mounted().emit("open-result", clip);
    await until(() => statusOf(host, "results-status") === "无法打开文件夹。");
    await host.command("clip.openFolder").run();
    await until(() => host.osd.at(-1) === "无法打开文件夹。");
    fakes.failOpen = false;
    // A moved file: nothing is opened, the row says so.
    await rm(destination);
    host.mounted().emit("open-result", clip);
    await until(() => rows(host).find((row) => row.id === clip)?.state === "gone");
    assert.equal(fakes.opened.length, 1, "nothing opened for a moved file");
    // Open Clip Folder checks and creates the folder before system.openPath.
    await rm(folder, { recursive: true });
    await host.command("clip.openFolder").run();
    await until(() => fakes.opened.length === 2);
    assert.equal(fakes.opened[1], folder);
    assert.equal(await exists(folder), true, "recreated");
    host.mounted().emit("set-beside-media", true);
    await host.settle();
    host.mounted().emit("open-folder");
    await until(() => fakes.opened.length === 3);
    assert.equal(fakes.opened[2], media);
    await exportTyped(host, "0:05", "0:09", 2);
    assert.equal(host.sent("jobs.start")[1]!.destination, join(media, "movie_00.05.000-00.09.000.mp4"), "saved beside the media");
    host.openElsewhere("https://example.test/live.m3u8");
    await host.settle();
    await host.command("clip.openFolder").run();
    await until(() => fakes.opened.length === 4);
    assert.equal(fakes.opened[3], folder, "a URL source uses the clip folder");
  } finally {
    await stop();
    await cleanup();
    await rm(media, { recursive: true, force: true });
  }
});

test("the file-name template: edits rename the next clip; a chip adds a variable; Default name restores it", async () => {
  const host = new TestHost();
  ready(host);
  const { stop } = await start(host);
  const { folder, cleanup } = await withFolder(host);
  try {
    const panel = host.mounted();
    panel.emit("set-method", 1);
    panel.emit("template-edited", "cut {name}");
    panel.emit("insert-variable", "{start}");
    await host.settle();
    await eventually(() => tab(host).template, "cut {name}{start}");
    await eventually(() => tab(host).preview, "cut source-one04.02.300.mp4", "the preview names the playing file");
    await exportTyped(host, "0:01", "0:04", 1);
    assert.equal(host.sent("jobs.start")[0]!.destination, join(folder, "cut source-one00.01.000.mp4"));
    panel.emit("reset-template");
    await host.settle();
    await eventually(() => tab(host).template, "{name}_{start}-{end}");
  } finally {
    await stop();
    await cleanup();
  }
});

/** A fake ffprobe: the video's codec and start time, and key packets every 2 s (plus one at 241 s that is no keyframe). */
function probing(host: TestHost, offset = 0) {
  host.tools.handle("ffprobe", (args) =>
    args.some((arg) => arg.startsWith("stream=codec_name"))
      ? { stdout: `codec_name=h264\nstart_time=${offset.toFixed(6)}\n` }
      : { stdout: [236, 238, 240, 244].map((t) => `${(t + offset).toFixed(6)},K__`).concat([`${(241 + offset).toFixed(6)},___`]).join("\n") },
  );
}

test("Fast (R1): the default; keyframes from ffprobe on the player's clock; a stream copy from the keyframe; the range on the seek bar (R3) and in the row (R2)", async () => {
  const host = new TestHost();
  ready(host, "/contract/movie.mp4");
  host.setSource({ position: 250, duration: 600, audioTracks: TRACKS });
  // A file whose timestamps start at 1.4 s (MPEG-TS, say): ffprobe reports 1.4 s later than the player.
  probing(host, 1.4);
  const setJob = manualJobs(host);
  const { stop } = await start(host, "en");
  const { folder, cleanup } = await withFolder(host);
  try {
    const panel = host.mounted();
    await host.settle();
    await eventually(() => tab(host)["method-index"], 0, "Fast is the default");
    await eventually(() => tab(host).support, { fast: true, encode: true, progress: true });
    panel.emit("clip-edited", "4:02.3", "4:19");
    // The codec probe and the keyframe probe answer separately: wait for the note and the name they give.
    await until(() => (tab(host).note as { snapped: boolean; container: string }).snapped && (tab(host).note as { container: string }).container === "mp4" && tab(host)["clip-name"] === "movie_04.00.000-04.19.000.mp4");
    await eventually(() => tab(host).note, { method: "fast", start: "04:00.000", end: "04:19.000", early: "2.3", snapped: true, container: "mp4" });
    const line = tab(host).timeline as { key: number; gota: number; wanta: number; ticks: string };
    assert.ok(line.key >= 0 && line.gota < line.wanta && line.ticks.includes("M"));
    const probe = host.tools.calls.find((call) => call.args.includes("-read_intervals"))!;
    const window = probe.args[probe.args.indexOf("-read_intervals") + 1]!.split("%").map(Number);
    assert.ok(Math.abs(window[1]! - (timelineEnd(242.3, 259) + 1.4)) < 0.01, "the window in the file's timestamps");
    // R3: what the file will hold, on the seek bar while the tab shows.
    await until(() => (host.timeline.rangeLayers.get(ID) ?? []).length === 1);
    assert.deepEqual(host.timeline.rangeLayers.get(ID), [{ start: 240, end: 259, style: "selection", title: "Clip" }]);
    panel.emit("export-clip", "4:02.3", "4:19");
    await until(() => host.sent("jobs.start").length === 1);
    const capture = host.sent("snapshot.capture")[0]!;
    assert.deepEqual([capture.mode, capture.time], ["raw", 242.3], "a copy needs a raw snapshot");
    const job = host.sent("jobs.start")[0]!;
    assert.deepEqual([job.kind, job.end, job.container], ["rawCopy", 259, "auto"]);
    assert.equal(job.encoding, undefined);
    // The player wrote MKV and reports where the file really starts.
    const written = join(folder, "movie_04.00.000-04.19.000.mkv");
    await complete(setJob, host, 1, { destination: written, start: 239.96, end: 259.02 });
    await until(() => rows(host)[0]?.state === "completed");
    const [row] = rows(host);
    assert.deepEqual([row!.name, row!.method, row!.range, row!.badge], ["movie_04.00.000-04.19.000.mkv", "fast", "03:59.960–04:19.020", "19.1"]);
    assert.equal(host.osd.at(-1), `Clip exported as ${written}`);
    // Precise: the exact frame; the seek bar follows.
    panel.emit("set-method", 1);
    await host.settle();
    await eventually(() => [(tab(host).note as { method: string; start: string }).method, (tab(host).note as { start: string }).start], ["precise", "04:02.300"]);
    await eventually(() => tab(host)["clip-name"], "movie_04.02.300-04.19.000.mp4");
    await until(() => host.timeline.rangeLayers.get(ID)?.[0]?.start === 242.3);
    // In the background the range goes.
    host.mountOther("sidebar", "vestra.playlist", { title: "Playlist" });
    host.selectTab("vestra.playlist");
    await until(() => !(host.timeline.rangeLayers.get(ID) ?? []).length);
    await host.settle();
    assert.deepEqual(host.keepsRunning, [], "an empty layer in the background keeps nothing running");
  } finally {
    await stop();
    await cleanup();
  }
});

test("a stream copy the player cannot make: Fast cut is not possible, Use Precise; an unknown source bitrate asks for another quality", async () => {
  const host = new TestHost();
  ready(host, "/contract/movie.mp4");
  host.setSource({ position: 5, duration: 600 });
  probing(host);
  const { stop } = await start(host, "en");
  const { cleanup } = await withFolder(host);
  try {
    host.exportFailure = { code: "unsupported", message: "codec vc1 cannot be copied" };
    host.mounted().emit("export-clip", "0:01", "0:04");
    await until(() => host.osd.at(-1) === `Export failed: ${REASON.fastImpossible}`);
    // The tab's values follow the OSD in their own update: wait for them.
    await until(() => (tab(host)["clip-status"] as { reason: string }).reason === "fastImpossible" && rows(host)[0]?.reason === "fastImpossible");
    // Same as source on a file whose bitrate the player cannot tell.
    host.mounted().emit("set-method", 1);
    host.mounted().emit("set-preset", 0);
    host.mounted().emit("export-clip", "0:01", "0:04");
    await until(() => host.osd.at(-1) === `Export failed: ${REASON.noSourceBitrate}`);
    const job = host.sent("jobs.start").at(-1)!;
    assert.deepEqual([job.kind, (job.encoding as { videoBitrate?: string }).videoBitrate, "crf" in (job.encoding as object)], ["rawMp4", "source", false]);
  } finally {
    host.exportFailure = null;
    await stop();
    await cleanup();
  }
});

test("task rows changed after an await call plugin.update() (trimming history, a job's first state)", async () => {
  const seen: { length: number; status: string }[] = [];
  const scope = { update: () => seen.push({ length: tasks.list.length, status: tasks.list.at(-1)!.status }) } as never;
  const tasks: Tasks = new Tasks(scope, () => {});
  const spec = { start: 0, end: 1, processed: false, subtitles: false, track: "none", method: "precise" } as const;
  const later = <T>(value: T) => new Promise<T>((done) => setTimeout(() => done(value), 5));
  for (let i = 0; i < 21; i++) {
    const snapshot = { dispose: () => later(undefined) } as never;
    tasks.list.push({ id: `old${i}`, spec, sourceId: 1, source: "a", snapshot, destination: "x.mp4", status: "failed", cancel: false, jobs: [], progress: null } as Task);
  }
  let exported!: (job: unknown) => void;
  const job = { state: { status: "running" }, done: new Promise(() => {}), onChange: () => ({ dispose: async () => {} }), cancel: async () => {} };
  const snapshot = { export: () => new Promise((done) => (exported = done)), dispose: async () => {} } as never;
  tasks.add({ spec, sourceId: 1, source: "a", snapshot, destination: "new.mp4" });
  await until(() => seen.at(-1)?.length === 20);
  assert.equal(tasks.list.length, 20);
  exported(job);
  await until(() => seen.at(-1)?.status === "running");
  assert.equal(tasks.list.at(-1)!.status, "running");
});

test("0.2.x and 0.3.x kept the Collection page: it opens as the Clip page, which holds the Collection", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  try {
    await writeFile(join(data, "settings.json"), JSON.stringify({ page: "collection", method: "precise" }));
    const host = new TestHost();
    ready(host);
    const { stop } = await start(host, "en", data);
    try {
      await host.settle();
      await eventually(() => tab(host).page, 0, "the Clip page");
      await eventually(() => tab(host)["method-index"], 1, "the other settings are kept");
      host.mounted().emit("set-page", 3);
      await host.settle();
      await jsonFile(join(data, "settings.json"), (v) => v.page === "settings");
    } finally {
      await stop();
    }
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("real pages: the last sub-tab is remembered; commands select their page", async () => {
  const data = await mkdtemp(join(tmpdir(), "clipexport-data-"));
  const host = new TestHost();
  ready(host);
  const first = await start(host, "en", data);
  try {
    await host.settle();
    await eventually(() => tab(host).page, 0, "Clip first");
    await host.command("clip.tasks").run();
    await host.settle();
    await eventually(() => tab(host).page, 2, "Export Tasks… shows Results");
    await host.command("clip.settings").run();
    await host.settle();
    await eventually(() => tab(host).page, 3, "Clip Export Settings… shows Settings");
    // Show Collection: the Clip page (the Collection is its section), the list asked into view each time.
    const asked = Number(tab(host)["list-focus"] ?? 0);
    await host.command("clip.collection").run();
    await host.settle();
    await eventually(() => [tab(host).page, tab(host)["list-focus"]], [0, asked + 1], "Show Collection shows the Clip page, list focused");
    await host.command("clip.collection").run();
    await host.settle();
    await eventually(() => tab(host)["list-focus"], asked + 2, "again: the list is asked into view again");
    host.mounted().emit("set-page", 2);
    await host.settle();
    await jsonFile(join(data, "settings.json"), (v) => v.page === "results");
    await first.stop();
    const again = new TestHost();
    ready(again);
    const second = await startPlugin(activate, { directory, host: again, dataDirectory: data, locale: "en" });
    await again.settle();
    await eventually(() => tab(again).page, 2, "the Results page again after a restart");
    await again.command("clip.open").run();
    await again.settle();
    await eventually(() => tab(again).page, 0);
    await second.stop();
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("store listing: the id of the directory and a 256×256 PNG icon", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
  assert.equal(manifest.id, ID); // <owner>.<directory>, as the repository requires
  assert.equal(manifest.icon, "assets/icon.png");
  const png = await readFile(new URL(manifest.icon, directory));
  assert.equal(png.toString("latin1", 1, 4), "PNG");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [256, 256]);
});
