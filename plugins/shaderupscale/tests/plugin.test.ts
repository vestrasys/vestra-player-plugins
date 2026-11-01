import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate, { OSD_BUDGET, shaderPath, WINDOW_TITLE } from "../main.ts";
import {
  ANIME4K_MODES,
  ANIME4K_QUALITIES,
  anime4kFiles,
  ARTCNN_SIZES,
  ARTCNN_STYLES,
  artcnnFiles,
  DEFAULT_SETTINGS,
  isSettings,
} from "../presets.ts";

const directory = new URL("..", import.meta.url);
const SHADERS = new URL("../shaders/", import.meta.url);
type Locale = "en" | "zh-Hans";
const HANDLE = "upscale";
const ITEM = "shaderupscale.window";

/** A Windows player drawing on the GPU (Video ▸ GPU Rendering on); the TestHost is macOS by default. */
function windowsGpu() {
  const host = new TestHost();
  host.systemInfo = { ...host.systemInfo, os: "windows", name: "Windows" };
  return host;
}

/** A Windows player in software rendering, the default there. */
function windowsSoftware() {
  const host = windowsGpu();
  host.videoRender.gpu = false;
  host.rendering.startedWith = "software";
  // The player reports the Windows default (GPU rendering off) as the next start in software too.
  host.rendering.preference = "software";
  host.rendering.reason = { code: "preference", message: "GPU rendering is off (Video ▸ GPU Rendering)" };
  return host;
}

async function start(host = windowsGpu(), locale: Locale = "en", dataDirectory?: string) {
  const started = await startPlugin(activate, { directory, host, locale, ...(dataDirectory ? { dataDirectory } : {}) });
  return { ...started, host };
}

/** Start the plugin, play a video and open the window from the menu item. */
async function opened(host = windowsGpu(), locale: Locale = "en", dataDirectory?: string) {
  const started = await start(host, locale, dataDirectory);
  host.openElsewhere("/media/clip.mkv");
  await host.command(ITEM).run();
  await host.settle();
  return { ...started, window: host.window("upscale") };
}

/** What the player holds for the plugin's handle (`undefined`: nothing). */
const held = (host: TestHost) => host.videoShaders.handles.get(HANDLE);
const paths = (files: string[]) => files.map(shaderPath);
const saved = async (data: string) => JSON.parse(await readFile(join(data, "upscaling.json"), "utf8"));

/**
 * Retry `check` until it passes, 20 ms at a time for up to 2 s, then fail
 * with its last error. Turning shaders on writes `guard.json` before they are
 * sent: the plugin's own file I/O, which `host.settle()` does not wait for
 * (testing.d.ts, `settle`). Every assertion that follows such a write polls.
 */
async function eventually(host: TestHost, check: () => unknown) {
  const end = Date.now() + 2000;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > end) throw error;
    }
    await host.settle(20);
  }
}

// ------------------------------------------------------------------ presets

test("presets: every chain is Anime4K's own template, and every file is bundled", () => {
  // Upstream md/Template/GLSL_Mac_Linux_High-end/input.conf, mode A (HQ) and C+A (HQ).
  assert.deepEqual(anime4kFiles("A", "hq"), [
    "anime4k/Anime4K_Clamp_Highlights.glsl",
    "anime4k/Anime4K_Restore_CNN_VL.glsl",
    "anime4k/Anime4K_Upscale_CNN_x2_VL.glsl",
    "anime4k/Anime4K_AutoDownscalePre_x2.glsl",
    "anime4k/Anime4K_AutoDownscalePre_x4.glsl",
    "anime4k/Anime4K_Upscale_CNN_x2_M.glsl",
  ]);
  assert.deepEqual(anime4kFiles("C+A", "hq"), [
    "anime4k/Anime4K_Clamp_Highlights.glsl",
    "anime4k/Anime4K_Upscale_Denoise_CNN_x2_VL.glsl",
    "anime4k/Anime4K_AutoDownscalePre_x2.glsl",
    "anime4k/Anime4K_AutoDownscalePre_x4.glsl",
    "anime4k/Anime4K_Restore_CNN_M.glsl",
    "anime4k/Anime4K_Upscale_CNN_x2_M.glsl",
  ]);
  // Low-end template, mode B+B (Fast).
  assert.deepEqual(anime4kFiles("B+B", "fast"), [
    "anime4k/Anime4K_Clamp_Highlights.glsl",
    "anime4k/Anime4K_Restore_CNN_Soft_M.glsl",
    "anime4k/Anime4K_Upscale_CNN_x2_M.glsl",
    "anime4k/Anime4K_AutoDownscalePre_x2.glsl",
    "anime4k/Anime4K_AutoDownscalePre_x4.glsl",
    "anime4k/Anime4K_Restore_CNN_Soft_S.glsl",
    "anime4k/Anime4K_Upscale_CNN_x2_S.glsl",
  ]);
  assert.deepEqual(artcnnFiles("c4f32", "ds"), ["artcnn/ArtCNN_C4F32_DS.glsl"]);
  assert.deepEqual(artcnnFiles("c4f16", "neutral"), ["artcnn/ArtCNN_C4F16.glsl"]);
});

test("presets: the package ships exactly the shaders the presets use, each with its licence", async () => {
  const used = new Set<string>();
  for (const mode of ANIME4K_MODES)
    for (const quality of ANIME4K_QUALITIES) {
      const files = anime4kFiles(mode, quality);
      assert.ok(files.length <= 16 && new Set(files).size === files.length, `${mode} ${quality}`);
      files.forEach((file) => used.add(file));
    }
  for (const size of ARTCNN_SIZES) for (const style of ARTCNN_STYLES) artcnnFiles(size, style).forEach((file) => used.add(file));
  const shipped = new Set<string>();
  for (const model of ["anime4k", "artcnn"]) {
    const names = await readdir(new URL(`${model}/`, SHADERS));
    assert.ok(names.includes("LICENSE"), `${model}: licence text`);
    names.filter((name) => name.endsWith(".glsl")).forEach((name) => shipped.add(`${model}/${name}`));
  }
  assert.deepEqual([...used].sort(), [...shipped].sort());
  for (const file of used) assert.ok(existsSync(shaderPath(file)), file);
  assert.ok(existsSync(new URL("SOURCES.txt", SHADERS)));
});

test("settings: the defaults are valid; broken or unknown values are refused", () => {
  assert.equal(isSettings(DEFAULT_SETTINGS), true);
  assert.equal(isSettings({ ...DEFAULT_SETTINGS, model: "fsrcnnx" }), false);
  assert.equal(isSettings({ ...DEFAULT_SETTINGS, anime4k: { mode: "D", quality: "fast" } }), false);
  assert.equal(isSettings({ ...DEFAULT_SETTINGS, artcnn: { size: "c4f16" } }), false);
  assert.equal(isSettings(null), false);
});

// ------------------------------------------------------------------ the menu item

test("one menu item, Video ▸ Shader Upscaling…, next to the rendering items; nothing applied while off", async () => {
  const { host, stop } = await start();
  try {
    const item = host.command(ITEM);
    assert.deepEqual(item.declaration.path, ["@video", WINDOW_TITLE]);
    assert.equal(item.declaration.group, "video-rendering");
    assert.equal(item.declaration.order, 463);
    assert.deepEqual([...host.commands.keys()], [ITEM]); // no toggle items in the menu
    host.openElsewhere("/media/clip.mkv");
    await host.settle();
    assert.equal(held(host), undefined);
    // Off, it holds nothing: with lazy activation the player may stop it.
    assert.deepEqual(host.keepsRunning, []);
  } finally {
    await stop();
  }
});

// ------------------------------------------------------------------ the window

test("window: the defaults, one click on, the status says what is applied, one click off", async () => {
  const { host, window, stop } = await opened();
  try {
    assert.equal(window.visible, true);
    assert.deepEqual(window.props.models, ["Anime4K", "ArtCNN"]);
    assert.equal(window.props["model-index"], 0);
    assert.equal(window.props["param-a-label"], "Mode");
    assert.deepEqual(window.props["param-a-items"], [
      "Mode A",
      "Mode B",
      "Mode C",
      "Mode A+A (demanding)",
      "Mode B+B (demanding)",
      "Mode C+A (demanding)",
    ]);
    assert.deepEqual(window.props["param-b-items"], ["Fast: smaller networks, most GPUs", "HQ (demanding): large networks, fast GPU"]);
    assert.equal(window.props["param-a-index"], 0);
    assert.equal(window.props["param-b-label"], "Quality");
    assert.equal(window.props["param-b-index"], 0);
    assert.match(String(window.props.description), /^Anime4K: .*\nMode A: .*\nFast runs/);
    assert.equal(window.props.on, false);
    assert.equal(window.props.status, "Off");
    assert.equal(window.props.tone, 0);
    assert.equal(window.props["can-toggle"], true);

    window.emit("toggle");
    await eventually(host, () => {
      assert.deepEqual(held(host), paths(anime4kFiles("A", "fast")));
      assert.equal(window.props.on, true);
      assert.equal(window.props.status, "On: Anime4K mode A (Fast)");
      assert.equal(window.props.tone, 1);
      assert.equal(host.osd.at(-1), "Shader Upscaling: On, Anime4K mode A (Fast)");
    });

    window.emit("toggle");
    await eventually(host, () => {
      assert.equal(held(host), undefined);
      assert.equal(window.props.status, "Off");
      assert.equal(host.osd.at(-1), "Shader Upscaling: Off");
    });
    // Off and the window closed: the handle is gone, nothing keeps the plugin running.
    window.userClose();
    await host.settle();
    assert.deepEqual(host.keepsRunning, []);
  } finally {
    await stop();
  }
});

test("window: a new mode, quality or model applies at once while on, and is remembered per model", async () => {
  const data = await mkdtemp(join(tmpdir(), "shaderupscale-"));
  const { host, window, stop } = await opened(windowsGpu(), "en", data);
  try {
    window.emit("toggle");
    await eventually(host, () => assert.deepEqual(held(host), paths(anime4kFiles("A", "fast"))));
    window.emit("pickA", 3); // A+A
    window.emit("pickB", 1); // HQ
    await eventually(host, () => {
      assert.deepEqual(held(host), paths(anime4kFiles("A+A", "hq")));
      assert.equal(window.props["param-a-index"], 3);
      assert.equal(window.props.status, "On: Anime4K mode A+A (HQ)");
    });

    window.emit("pickModel", 1); // ArtCNN
    await eventually(host, () => assert.deepEqual(held(host), paths(["artcnn/ArtCNN_C4F16.glsl"])));
    assert.equal(window.props["param-a-label"], "Size");
    assert.equal(window.props["param-b-label"], "Variant");
    assert.deepEqual(window.props["param-b-items"], ["Neutral", "Denoise and sharpen", "Denoise and soften"]);
    assert.deepEqual(window.props["param-a-items"], [
      "C4F16: light on the GPU",
      "C4F32 (demanding): more detail, needs a faster GPU",
    ]);
    window.emit("pickA", 1);
    window.emit("pickB", 1);
    await eventually(host, () => {
      assert.deepEqual(held(host), paths(["artcnn/ArtCNN_C4F32_DS.glsl"]));
      assert.equal(window.props.status, "On: ArtCNN C4F32 (Denoise and sharpen)");
    });
    assert.match(String(window.props.description), /\nC4F32 \(demanding\) runs/);

    // Back to Anime4K: its own parameters are as they were.
    window.emit("pickModel", 0);
    await eventually(host, () => assert.deepEqual(held(host), paths(anime4kFiles("A+A", "hq"))));
    assert.equal(window.props["param-a-index"], 3);
    assert.equal(window.props["param-b-index"], 1);
    // An index out of range changes nothing.
    window.emit("pickA", 99);
    await host.settle();
    assert.deepEqual(held(host), paths(anime4kFiles("A+A", "hq")));
  } finally {
    await stop();
  }
  assert.deepEqual(await saved(data), {
    on: true,
    model: "anime4k",
    anime4k: { mode: "A+A", quality: "hq" },
    artcnn: { size: "c4f32", style: "ds" },
  });
});

test("while off, a choice is only saved; on applies it", async () => {
  const { host, window, stop } = await opened();
  try {
    window.emit("pickA", 2); // C
    await host.settle();
    assert.equal(held(host), undefined);
    assert.equal(window.props.status, "Off");
    window.emit("toggle");
    await eventually(host, () => assert.deepEqual(held(host), paths(anime4kFiles("C", "fast"))));
  } finally {
    await stop();
  }
});

test("restart: the saved choice is applied again at once, without opening the window", async () => {
  const data = await mkdtemp(join(tmpdir(), "shaderupscale-"));
  const first = await opened(windowsGpu(), "en", data);
  first.window.emit("pickModel", 1);
  first.window.emit("toggle");
  await eventually(first.host, () => assert.deepEqual(held(first.host), paths(["artcnn/ArtCNN_C4F16.glsl"])));
  await first.stop();

  const { host, stop } = await start(windowsGpu(), "en", data);
  try {
    host.openElsewhere("/media/clip.mkv");
    await host.settle();
    assert.deepEqual(held(host), paths(["artcnn/ArtCNN_C4F16.glsl"]));
  } finally {
    await stop();
  }
});

// ------------------------------------------------------------------ crash safety

const guardFile = async (data: string) => JSON.parse(await readFile(join(data, "guard.json"), "utf8"));

test("crash safety: the flag is set while shaders are applied and cleared when withdrawn or at a clean stop", async () => {
  const data = await mkdtemp(join(tmpdir(), "shaderupscale-"));
  const { host, window, stop } = await opened(windowsGpu(), "en", data);
  try {
    window.emit("toggle");
    await eventually(host, () => assert.deepEqual(held(host), paths(anime4kFiles("A", "fast"))));
    // On disk before the shaders were sent.
    assert.deepEqual(await guardFile(data), { active: true });
    window.emit("toggle");
    await eventually(host, async () => {
      assert.equal(held(host), undefined);
      assert.deepEqual(await guardFile(data), { active: false });
    });
    window.emit("toggle");
    await eventually(host, () => assert.deepEqual(held(host), paths(anime4kFiles("A", "fast"))));
    assert.deepEqual(await guardFile(data), { active: true });
  } finally {
    await stop();
  }
  // A clean stop with the shaders on: cleared, and the next start applies them again.
  assert.deepEqual(await guardFile(data), { active: false });
  const second = await opened(windowsGpu(), "en", data);
  try {
    assert.deepEqual(held(second.host), paths(anime4kFiles("A", "fast")));
    assert.equal(second.window.props.status, "On: Anime4K mode A (Fast)");
  } finally {
    await second.stop();
  }
});

test("crash safety: after the player did not close normally with shaders on, it starts with them off and says why", async () => {
  const data = await mkdtemp(join(tmpdir(), "shaderupscale-"));
  // What an unclean exit leaves: on, and the flag still set.
  await writeFile(join(data, "upscaling.json"), JSON.stringify({ ...DEFAULT_SETTINGS, on: true, anime4k: { mode: "A+A", quality: "hq" } }));
  await writeFile(join(data, "guard.json"), JSON.stringify({ active: true }));
  const { host, window, stop } = await opened(windowsGpu(), "en", data);
  try {
    assert.equal(held(host), undefined);
    assert.equal(host.sent("video.shaders.set").length, 0);
    assert.equal(host.osd[0], "Shader Upscaling turned off: the player did not close normally");
    assert.equal(window.props.on, false);
    assert.equal(window.props.status, "Off");
    assert.match(String(window.props.detail), /^Shader upscaling was turned off because the player did not close normally/);
    // The choice is kept; turning on again applies it and the note goes.
    assert.equal(window.props["param-a-index"], 3);
    window.emit("toggle");
    await eventually(host, () => assert.deepEqual(held(host), paths(anime4kFiles("A+A", "hq"))));
    window.emit("toggle");
    await eventually(host, () => {
      assert.equal(held(host), undefined);
      assert.equal(window.props.detail, "");
    });
  } finally {
    await stop();
  }
  assert.equal((await saved(data)).on, false);
  assert.deepEqual(await guardFile(data), { active: false });
});

test("crash safety: a restart of the plugin within one player run keeps the shaders on", async () => {
  const data = await mkdtemp(join(tmpdir(), "shaderupscale-"));
  const first = await opened(windowsGpu(), "en", data);
  first.window.emit("toggle");
  await eventually(first.host, () => assert.deepEqual(held(first.host), paths(anime4kFiles("A", "fast"))));
  const session = first.host.sessionStorage;
  await first.stop();
  // The plugin's process ended without its clean stop (a crash of the plugin, not of the player).
  await writeFile(join(data, "guard.json"), JSON.stringify({ active: true }));
  const { host, stop } = await startPlugin(activate, { directory, host: windowsGpu(), locale: "en", dataDirectory: data, sessionStorage: session });
  try {
    host.openElsewhere("/media/clip.mkv");
    await host.settle();
    assert.deepEqual(held(host), paths(anime4kFiles("A", "fast")));
    assert.equal(host.osd.length, 0);
  } finally {
    await stop();
  }
});

test("software rendering: greyed out with what to do; nothing sent; a saved 'on' can still be turned off", async () => {
  const { host, window, stop } = await opened(windowsSoftware());
  try {
    assert.equal(window.props.status, "Not available");
    assert.equal(window.props.tone, 3);
    assert.equal(window.props["can-toggle"], false);
    assert.match(String(window.props.detail), /turn on Video ▸ GPU Rendering \(Experimental\), then restart the player/);
    assert.equal(held(host), undefined);
  } finally {
    await stop();
  }

  // GPU chosen for the next start: the advice is to restart.
  const next = windowsSoftware();
  next.rendering.preference = "gpu";
  const second = await opened(next);
  try {
    assert.match(String(second.window.props.detail), /on from the next start: restart the player/);
  } finally {
    await second.stop();
  }

  // Linux: no GPU renderer at all.
  const linux = windowsSoftware();
  linux.systemInfo = { ...linux.systemInfo, os: "linux", name: "Linux" };
  linux.rendering.reason = { code: "no-gpu-backend", message: "this player has no GPU renderer on Linux yet" };
  linux.rendering.gpu = { available: false, reason: linux.rendering.reason };
  const third = await opened(linux);
  try {
    assert.equal(
      third.window.props.detail,
      "Shader upscaling needs GPU rendering, which cannot be turned on here: this player has no GPU renderer on Linux yet",
    );
  } finally {
    await third.stop();
  }
});

test("software rendering with a saved 'on': nothing sent, the button turns it off", async () => {
  const data = await mkdtemp(join(tmpdir(), "shaderupscale-"));
  const first = await opened(windowsGpu(), "en", data);
  first.window.emit("toggle");
  await eventually(first.host, () => assert.deepEqual(held(first.host), paths(anime4kFiles("A", "fast"))));
  await first.stop();

  const { host, window, stop } = await opened(windowsSoftware(), "en", data);
  try {
    assert.equal(held(host), undefined);
    assert.equal(host.sent("video.shaders.set").length, 0);
    assert.equal(window.props.on, true);
    assert.equal(window.props["can-toggle"], true);
    assert.equal(window.props.status, "Not available");
    window.emit("toggle");
    await host.settle();
    assert.equal(window.props.on, false);
    assert.equal(window.props["can-toggle"], false);
  } finally {
    await stop();
  }
});

test("a switch to software rendering during the run: the status says to restart", async () => {
  const { host, window, stop } = await opened();
  try {
    window.emit("toggle");
    await eventually(host, () => assert.deepEqual(held(host), paths(anime4kFiles("A", "fast"))));
    host.failVideoRender("unsupported", "the player switched to software rendering");
    await host.settle();
    assert.equal(held(host), undefined);
    assert.equal(window.props.status, "Not available");
    assert.match(String(window.props.detail), /GPU rendering stopped during this run: restart the player/);
    assert.equal(window.props["can-toggle"], true); // still on: it can be turned off
  } finally {
    await stop();
  }
});

test("macOS: Anime4K runs; ArtCNN (compute shaders) is greyed out with the reason", async () => {
  const host = new TestHost(); // macOS on the GPU
  const { window, stop } = await opened(host);
  try {
    window.emit("toggle");
    await eventually(host, () => assert.deepEqual(held(host), paths(anime4kFiles("A", "fast"))));
    window.emit("pickModel", 1);
    await eventually(host, () => assert.equal(held(host), undefined)); // withdrawn
    assert.equal(window.props.status, "Not available");
    assert.match(String(window.props.detail), /^ArtCNN needs compute shaders/);
    assert.equal(window.props["can-toggle"], true); // on: can be turned off
    window.emit("toggle");
    await host.settle();
    assert.equal(window.props["can-toggle"], false);
    window.emit("pickModel", 0);
    await host.settle();
    assert.equal(window.props["can-toggle"], true);
    assert.equal(window.props.status, "Off");
  } finally {
    await stop();
  }
});

test("a shader that does not compile: the status and the OSD say so, once", async () => {
  const { host, window, stop } = await opened();
  try {
    window.emit("toggle");
    await eventually(host, () => assert.deepEqual(held(host), paths(anime4kFiles("A", "fast"))));
    host.failVideoShaders(HANDLE, "shader compile failed: ERROR: 0:39: 'x' : undeclared identifier");
    await host.settle();
    assert.equal(window.props.status, "On, but a shader did not compile");
    assert.equal(window.props.tone, 3);
    assert.match(String(window.props.detail), /ERROR: 0:39/);
    assert.equal(host.osd.at(-1), "Shader Upscaling: a shader did not compile");
    host.failVideoShaders(HANDLE, "shader compile failed again");
    await host.settle();
    assert.equal(host.osd.filter((line) => /did not compile/.test(line)).length, 1);
  } finally {
    await stop();
  }
});

test("other plugins hold most of the 16 shaders: the status says there is no room", async () => {
  const host = windowsGpu();
  host.videoShaders.others = 12;
  const { window, stop } = await opened(host);
  try {
    window.emit("toggle");
    await eventually(host, () => assert.equal(window.props.status, "On, but not applied"));
    assert.match(String(window.props.detail), /^Other plugins' shaders leave no room/);
    // ArtCNN is one shader: it fits.
    window.emit("pickModel", 1);
    await eventually(host, () => {
      assert.deepEqual(held(host), paths(["artcnn/ArtCNN_C4F16.glsl"]));
      assert.equal(window.props.status, "On: ArtCNN C4F16 (Neutral)");
    });
  } finally {
    await stop();
  }
});

test("Close and the title-bar button close the window", async () => {
  const { host, window, stop } = await opened();
  try {
    window.userClose();
    window.emit("closeWindow"); // the click raced the title-bar close
    await host.settle();
    assert.equal(host.windows.has("upscale"), false);
  } finally {
    await stop();
  }
});

// ------------------------------------------------------------------ languages

test("Simplified Chinese: the menu, the window and the OSD are translated", async () => {
  const { host, window, stop } = await opened(windowsGpu(), "zh-Hans");
  try {
    assert.deepEqual(host.command(ITEM).display.path, ["视频", "着色器超分辨率…"]);
    assert.equal(window.props.status, "关");
    assert.equal(window.props["param-a-label"], "模式");
    window.emit("toggle");
    await eventually(host, () => {
      assert.equal(window.props.status, "开：Anime4K 模式 A（快速）");
      assert.equal(host.osd.at(-1), "着色器超分辨率：开，Anime4K 模式 A（快速）");
    });
  } finally {
    await stop();
  }
});

for (const locale of ["en", "zh-Hans"] as const) {
  test(`${locale}: every OSD line fits the OSD's budget`, async () => {
    const budget = locale === "en" ? OSD_BUDGET.en : OSD_BUDGET.zh;
    // The longest presets, software rendering and macOS with ArtCNN.
    const gpuRun = await opened(windowsGpu(), locale);
    gpuRun.window.emit("pickA", 3);
    gpuRun.window.emit("pickB", 1);
    gpuRun.window.emit("toggle");
    await eventually(gpuRun.host, () => assert.deepEqual(held(gpuRun.host), paths(anime4kFiles("A+A", "hq"))));
    gpuRun.window.emit("pickModel", 1);
    gpuRun.window.emit("pickB", 1);
    gpuRun.window.emit("toggle");
    gpuRun.window.emit("toggle");
    await eventually(gpuRun.host, () => {
      assert.deepEqual(held(gpuRun.host), paths(["artcnn/ArtCNN_C4F16_DS.glsl"]));
      assert.equal(gpuRun.host.osd.length, 3); // on, off, on
    });
    gpuRun.host.failVideoShaders(HANDLE, "broken");
    await eventually(gpuRun.host, () => assert.equal(gpuRun.host.osd.length, 4));
    const lines = [...gpuRun.host.osd];
    await gpuRun.stop();
    const soft = await opened(windowsSoftware(), locale);
    // Turned on in an earlier run is the only way to reach "on" here; the OSD of a refused toggle is what counts.
    soft.window.emit("toggle");
    await soft.host.settle();
    lines.push(...soft.host.osd);
    await soft.stop();
    const mac = await opened(new TestHost(), locale);
    mac.window.emit("pickModel", 1);
    mac.window.emit("toggle");
    await mac.host.settle();
    lines.push(...mac.host.osd);
    await mac.stop();
    // Started after the player did not close normally with the shaders on.
    const data = await mkdtemp(join(tmpdir(), "shaderupscale-"));
    await writeFile(join(data, "upscaling.json"), JSON.stringify({ ...DEFAULT_SETTINGS, on: true }));
    await writeFile(join(data, "guard.json"), JSON.stringify({ active: true }));
    const crashed = await opened(windowsGpu(), locale, data);
    assert.equal(crashed.host.osd.length, 1);
    lines.push(...crashed.host.osd);
    await crashed.stop();
    assert.ok(lines.length >= 5);
    for (const line of lines) assert.ok(line.length <= budget, `${line.length} > ${budget}: ${line}`);
  });
}

// ------------------------------------------------------------------ the store listing

test("store listing: the id of the directory, the name, a 256×256 icon, the player version", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
  assert.equal(manifest.id, "zysilm.shaderupscale"); // <owner>.<directory>, as the repository requires
  assert.equal(manifest.name, "Shader Upscale for Vestra Player");
  assert.equal(manifest.minPlayerVersion, "0.6.0"); // the shader channel (0.5.20) and the Choice drop-down (0.6.0)
  assert.equal(manifest.icon, "assets/icon.png");
  const png = await readFile(new URL(manifest.icon, directory));
  assert.equal(png.toString("latin1", 1, 4), "PNG");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [256, 256]);
});
