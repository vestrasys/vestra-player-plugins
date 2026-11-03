import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostError, startPlugin, TestHost } from "@vestra-player/sdk/testing";
import activate, { OSD_BUDGET, shaderPath, WINDOW_TITLE } from "../main.ts";
import {
  ANIME4K_MODES,
  ANIME4K_QUALITIES,
  anime4kFiles,
  CHROMA_FILE,
  DEFAULT_SETTINGS,
  FSR_FILES,
  isSettings,
  MAX_SHADERS,
  MODELS,
  readSettings,
  type Settings,
  SHARPEN_FILE,
  shaderFiles,
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
 * with its last error. Some outcomes come after work `host.settle()` does
 * not wait for (testing.d.ts, `settle`): the plugin's own file I/O (the
 * saved settings) and the wait for the player's answer before the OSD line of
 * Turn On. Every assertion that follows such work polls.
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
});

/** Every combination of choices the window offers. */
function allSettings(): Settings[] {
  const result: Settings[] = [];
  for (const model of MODELS)
    for (const mode of ANIME4K_MODES)
      for (const quality of ANIME4K_QUALITIES)
        for (const chroma of [false, true])
          for (const sharpen of [false, true]) result.push({ on: true, model, anime4k: { mode, quality }, chroma, sharpen });
  return result;
}

/**
 * The shader directories: the licence notice each file carries in its header
 * (before the first `//!` pass), and how the directory's LICENSE file starts.
 */
const LICENCES: Record<string, { header: RegExp; licence: RegExp }> = {
  anime4k: { header: /MIT License|unencumbered software released into the public domain/, licence: /^MIT License\n\nCopyright \(c\) 2019 bloc97/ },
  fsr: {
    header: /Copyright \(c\) 2021 Advanced Micro Devices, Inc\. All rights reserved\.\n\/\/\n\/\/ Permission is hereby granted/,
    licence: /^Copyright \(c\) 2021 Advanced Micro Devices, Inc\. All rights reserved\.\n\nPermission is hereby granted/,
  },
  cfl: { header: /MIT License\n\n\/\/ Copyright \(c\) 2023 João Chrisóstomo/, licence: /^MIT License\n\nCopyright \(c\) 2023 João Chrisóstomo/ },
  "adaptive-sharpen": {
    header: /Copyright \(c\) 2015-2021, bacondither\n\/\/ All rights reserved\.\n\/\/\n\/\/ Redistribution and use/,
    licence: /^Copyright \(c\) 2015-2021, bacondither\nAll rights reserved\.\n\nRedistribution and use/,
  },
};

/** Every shipped `.glsl`, relative to `shaders/` with `/`. */
async function shippedShaders() {
  const files: string[] = [];
  for (const entry of await readdir(SHADERS, { withFileTypes: true }))
    if (entry.isDirectory())
      for (const name of await readdir(new URL(`${entry.name}/`, SHADERS))) if (name.endsWith(".glsl")) files.push(`${entry.name}/${name}`);
  return files.sort();
}

test("presets: FSR is one file; the add-ons go before (chroma) and after (sharpen) the upscaler", () => {
  const anime = { ...DEFAULT_SETTINGS, on: true };
  assert.deepEqual(shaderFiles(anime), anime4kFiles("A", "fast"));
  assert.deepEqual(FSR_FILES, ["fsr/FSR.glsl"]);
  assert.deepEqual(shaderFiles({ ...anime, model: "fsr" }), ["fsr/FSR.glsl"]);
  assert.deepEqual(shaderFiles({ ...anime, model: "fsr", chroma: true }), [CHROMA_FILE, "fsr/FSR.glsl"]);
  assert.deepEqual(shaderFiles({ ...anime, model: "fsr", sharpen: true }), ["fsr/FSR.glsl", SHARPEN_FILE]);
  assert.deepEqual(shaderFiles({ ...anime, model: "fsr", chroma: true, sharpen: true }), [CHROMA_FILE, "fsr/FSR.glsl", SHARPEN_FILE]);
  assert.deepEqual(shaderFiles({ ...anime, chroma: true }), [CHROMA_FILE, ...anime4kFiles("A", "fast")]);
  assert.deepEqual(shaderFiles({ ...anime, anime4k: { mode: "B+B", quality: "hq" }, chroma: true, sharpen: true }), [
    CHROMA_FILE,
    ...anime4kFiles("B+B", "hq"),
    SHARPEN_FILE,
  ]);
  // FSR keeps Anime4K's parameters for when Anime4K is chosen again.
  assert.deepEqual(shaderFiles({ ...anime, model: "fsr", anime4k: { mode: "C+A", quality: "hq" } }), ["fsr/FSR.glsl"]);
  assert.equal(CHROMA_FILE, "cfl/CfL_Prediction_Lite.glsl");
  assert.equal(SHARPEN_FILE, "adaptive-sharpen/adaptive-sharpen.glsl");
});

test("presets: every combination stays within the player's 16 shaders, with no file twice", () => {
  assert.equal(MAX_SHADERS, 16);
  const combinations = allSettings();
  assert.equal(combinations.length, 2 * 6 * 2 * 4);
  let most = 0;
  for (const settings of combinations) {
    const files = shaderFiles(settings);
    assert.ok(files.length > 0 && files.length <= MAX_SHADERS, JSON.stringify(settings));
    assert.equal(new Set(files).size, files.length, JSON.stringify(settings));
    most = Math.max(most, files.length);
  }
  // Anime4K's longest chain (7, modes A+A and B+B) with both add-ons.
  assert.equal(most, 9);
});

test("presets: the package ships exactly the shaders the presets use, each with its licence header, LICENSE and SOURCES entry", async () => {
  const used = new Set(allSettings().flatMap(shaderFiles));
  const shipped = await shippedShaders();
  assert.deepEqual([...used].sort(), shipped);
  assert.deepEqual((await readdir(SHADERS)).sort(), ["SOURCES.txt", ...Object.keys(LICENCES)].sort());
  assert.deepEqual([...MODELS], ["anime4k", "fsr"]);
  const sources = await readFile(new URL("SOURCES.txt", SHADERS), "utf8");
  assert.doesNotMatch(sources, /artcnn/i);
  for (const [directory, { licence }] of Object.entries(LICENCES)) {
    const names = await readdir(new URL(`${directory}/`, SHADERS));
    assert.ok(names.includes("LICENSE"), `${directory}: licence text`);
    assert.match(await readFile(new URL(`${directory}/LICENSE`, SHADERS), "utf8"), licence, `${directory}/LICENSE`);
    assert.match(sources, new RegExp(`^${directory}/$`, "m"), `SOURCES.txt: ${directory}/`);
  }
  for (const file of shipped) {
    const [directory, name] = file.split("/") as [string, string];
    const glsl = await readFile(new URL(file, SHADERS), "utf8");
    const header = glsl.slice(0, glsl.indexOf("//!"));
    assert.match(header, LICENCES[directory]!.header, `licence header: ${file}`);
    // Named in SOURCES.txt: Anime4K's by the part after "Anime4K_" (written as "Restore_CNN_{VL,M,S}" there).
    const stem = name.replace(/^Anime4K_/, "").replace(/\.glsl$/, "").replace(/_(VL|M|S|x2|x4)$/, "");
    assert.ok(sources.includes(stem), `SOURCES.txt: ${file}`);
    assert.ok(existsSync(shaderPath(file)), file);
  }
});

test("presets: no shipped shader uses //!COMPUTE or //!PARAM, or GLSL beyond 4.10 (macOS OpenGL 4.1, mpv vo_gpu)", async () => {
  const shipped = await shippedShaders();
  assert.ok(shipped.length >= 17);
  for (const file of shipped) {
    const glsl = await readFile(new URL(file, SHADERS), "utf8");
    assert.doesNotMatch(glsl, /^\s*\/\/!\s*(COMPUTE|PARAM)\b/m, file);
    // An mpv user shader: fragment passes with a hook point and a hook() function.
    assert.match(glsl, /^\/\/!HOOK [A-Z]+$/m, file);
    assert.match(glsl, /\bvec4 hook\(\)/, file);
    assert.doesNotMatch(glsl, /\r/, file);
    // GLSL 4.10 has neither C-style initializer lists (4.20) nor arrays of arrays (4.30).
    assert.doesNotMatch(glsl, /=\s*\{/, file);
    assert.doesNotMatch(glsl, /^\s*(const\s+)?\w+\s+\w+\s*\[\w*\]\s*\[/m, file);
  }
});

test("presets: CfL is marked as modified; FSR and adaptive-sharpen are upstream's files unchanged", async () => {
  const cfl = await readFile(new URL(CHROMA_FILE, SHADERS), "utf8");
  assert.match(cfl, /^\/\/ Modified for Shader Upscale for Vestra Player/m);
  const sources = await readFile(new URL("SOURCES.txt", SHADERS), "utf8");
  assert.match(sources, /CfL_Prediction_Lite\.glsl[^]*Modified/);
  for (const file of [...FSR_FILES, SHARPEN_FILE]) assert.doesNotMatch(await readFile(new URL(file, SHADERS), "utf8"), /Vestra/, file);
});

test("settings: the defaults are valid; broken or unknown values are refused", () => {
  assert.equal(isSettings(DEFAULT_SETTINGS), true);
  assert.equal(isSettings({ ...DEFAULT_SETTINGS, model: "fsrcnnx" }), false);
  assert.equal(isSettings({ ...DEFAULT_SETTINGS, anime4k: { mode: "D", quality: "fast" } }), false);
  assert.equal(isSettings({ ...DEFAULT_SETTINGS, model: "artcnn" }), false);
  assert.equal(isSettings({ ...DEFAULT_SETTINGS, model: "fsr" }), true);
  assert.equal(isSettings({ ...DEFAULT_SETTINGS, chroma: "yes" }), false);
  assert.equal(isSettings({ on: false, model: "anime4k", anime4k: { mode: "A", quality: "fast" } }), false);
  // The defaults: Anime4K mode A in its Fast set, no add-ons.
  assert.deepEqual(DEFAULT_SETTINGS, { on: false, model: "anime4k", anime4k: { mode: "A", quality: "fast" }, chroma: false, sharpen: false });
  assert.equal(isSettings(null), false);
});

test("settings: 0.1.0's ArtCNN choice becomes Anime4K mode A (Fast), on/off kept; its ArtCNN parameters go", () => {
  const artcnn = { size: "c4f32", style: "ds" };
  assert.deepEqual(readSettings({ on: true, model: "artcnn", anime4k: { mode: "A+A", quality: "hq" }, artcnn }), {
    on: true,
    model: "anime4k",
    anime4k: { mode: "A", quality: "fast" },
    chroma: false,
    sharpen: false,
  });
  assert.deepEqual(readSettings({ on: false, model: "anime4k", anime4k: { mode: "C", quality: "hq" }, artcnn }), {
    on: false,
    model: "anime4k",
    anime4k: { mode: "C", quality: "hq" },
    chroma: false,
    sharpen: false,
  });
  // 0.1.1's settings: kept, with both add-ons off.
  assert.deepEqual(readSettings({ on: true, model: "anime4k", anime4k: { mode: "B", quality: "hq" } }), {
    on: true,
    model: "anime4k",
    anime4k: { mode: "B", quality: "hq" },
    chroma: false,
    sharpen: false,
  });
  const current = { on: true, model: "fsr", anime4k: { mode: "B", quality: "hq" }, chroma: true, sharpen: false };
  assert.deepEqual(readSettings(current), current);
  assert.equal(readSettings({ on: true, model: "fsrcnnx", anime4k: DEFAULT_SETTINGS.anime4k }), null);
  assert.equal(readSettings({ on: true, model: "anime4k", anime4k: { mode: "D", quality: "fast" } }), null);
  assert.equal(readSettings("on"), null);
});

test("settings: a saved ArtCNN choice is migrated at start, applied as Anime4K mode A (Fast) and saved", async () => {
  const data = await mkdtemp(join(tmpdir(), "shaderupscale-"));
  await writeFile(
    join(data, "upscaling.json"),
    JSON.stringify({ on: true, model: "artcnn", anime4k: { mode: "B", quality: "hq" }, artcnn: { size: "c4f32", style: "dn" } }),
  );
  const { host, window, stop } = await opened(windowsGpu(), "en", data);
  try {
    await eventually(host, () => {
      assert.deepEqual(held(host), paths(anime4kFiles("A", "fast")));
      assert.equal(window.props.status, "On: Anime4K mode A (Fast)");
    });
    assert.equal(host.osd.length, 0);
  } finally {
    await stop();
  }
  assert.deepEqual(await saved(data), { on: true, model: "anime4k", anime4k: { mode: "A", quality: "fast" }, chroma: false, sharpen: false });
  assert.deepEqual(
    (await readdir(data)).filter((name) => name.includes(".bad-")),
    [],
  );
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
    // Two upscalers: Anime4K first, the default.
    assert.deepEqual(window.props.models, ["Anime: Anime4K", "General: AMD FSR 1"]);
    assert.equal(window.props.chroma, false);
    assert.equal(window.props.sharpen, false);
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
    assert.match(String(window.props.description), /^Anime4K: .*can also remove fine detail.*\nMode A: .*\nFast runs/);
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

test("window: a new mode or quality applies at once while on, and is remembered", async () => {
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
    assert.match(String(window.props.description), /\nHQ \(demanding\) runs/);
    // An index out of range changes nothing; neither does the chosen model's index.
    window.emit("pickA", 99);
    window.emit("pickModel", 0);
    window.emit("pickModel", 9);
    await host.settle();
    assert.deepEqual(held(host), paths(anime4kFiles("A+A", "hq")));
  } finally {
    await stop();
  }
  assert.deepEqual(await saved(data), { on: true, model: "anime4k", anime4k: { mode: "A+A", quality: "hq" }, chroma: false, sharpen: false });
});

test("window: FSR has no parameter rows and applies at once; the add-ons combine with either upscaler and are remembered", async () => {
  const data = await mkdtemp(join(tmpdir(), "shaderupscale-"));
  const { host, window, stop } = await opened(windowsGpu(), "en", data);
  try {
    window.emit("toggle");
    await eventually(host, () => assert.deepEqual(held(host), paths(anime4kFiles("A", "fast"))));
    window.emit("pickModel", 1); // FSR
    await eventually(host, () => {
      assert.deepEqual(held(host), paths(["fsr/FSR.glsl"]));
      assert.equal(window.props["model-index"], 1);
      assert.equal(window.props.status, "On: AMD FSR 1");
    });
    // No parameters: the window hides both rows.
    assert.deepEqual(window.props["param-a-items"], []);
    assert.deepEqual(window.props["param-b-items"], []);
    assert.match(String(window.props.description), /^AMD FSR 1: for live action/);
    window.emit("toggleChroma", true);
    await eventually(host, () => {
      assert.deepEqual(held(host), paths([CHROMA_FILE, "fsr/FSR.glsl"]));
      assert.equal(window.props.chroma, true);
      assert.equal(window.props.status, "On: AMD FSR 1 + chroma");
    });
    window.emit("toggleSharpen", true);
    await eventually(host, () => {
      assert.deepEqual(held(host), paths([CHROMA_FILE, "fsr/FSR.glsl", SHARPEN_FILE]));
      assert.equal(window.props.sharpen, true);
      assert.equal(window.props.status, "On: AMD FSR 1 + chroma + sharpen");
    });
    // Back to Anime4K: its parameters were kept; the add-ons stay.
    window.emit("pickModel", 0);
    await eventually(host, () => {
      assert.deepEqual(held(host), paths([CHROMA_FILE, ...anime4kFiles("A", "fast"), SHARPEN_FILE]));
      assert.equal(window.props["param-a-label"], "Mode");
      assert.equal((window.props["param-a-items"] as unknown[]).length, 6);
    });
    window.emit("toggleChroma", false);
    await eventually(host, () => {
      assert.deepEqual(held(host), paths([...anime4kFiles("A", "fast"), SHARPEN_FILE]));
      assert.equal(window.props.status, "On: Anime4K mode A (Fast) + sharpen");
    });
    // Not a boolean: nothing changes.
    window.emit("toggleSharpen", "no");
    await host.settle();
    assert.equal(window.props.sharpen, true);
  } finally {
    await stop();
  }
  assert.deepEqual(await saved(data), { on: true, model: "anime4k", anime4k: { mode: "A", quality: "fast" }, chroma: false, sharpen: true });
});

test("window: the upscaler and add-ons chosen while off are only saved; on applies them together", async () => {
  const { host, window, stop } = await opened();
  try {
    window.emit("pickModel", 1);
    window.emit("toggleChroma", true);
    window.emit("toggleSharpen", true);
    await host.settle();
    assert.equal(held(host), undefined);
    assert.equal(window.props.status, "Off");
    window.emit("toggle");
    await eventually(host, () => {
      assert.deepEqual(held(host), paths([CHROMA_FILE, "fsr/FSR.glsl", SHARPEN_FILE]));
      assert.equal(host.osd.at(-1), "Shader Upscaling: On, AMD FSR 1 + chroma + sharpen");
    });
  } finally {
    await stop();
  }
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
  first.window.emit("pickA", 1);
  first.window.emit("toggle");
  await eventually(first.host, () => assert.deepEqual(held(first.host), paths(anime4kFiles("B", "fast"))));
  await first.stop();

  const { host, stop } = await start(windowsGpu(), "en", data);
  try {
    host.openElsewhere("/media/clip.mkv");
    await host.settle();
    assert.deepEqual(held(host), paths(anime4kFiles("B", "fast")));
  } finally {
    await stop();
  }
});

// ------------------------------------------------------------------ crash safety

/**
 * The player's crash guard (0.6.3) refuses a non-empty list with these
 * messages (`src/host/src/host/diagnostics.rs`, `ShaderGuard::refuse`): one
 * for the start after an abnormal end, one for the block after a second
 * within a day. The plugin ids in parentheses are the plugins that drew then.
 */
const CRASH_THIS_START =
  "plugin shaders are off for this start: the player ended unexpectedly while they were on (zysilm.shaderupscale); the next start applies them again";
const CRASH_DAYS =
  "plugin shaders are off: the player ended unexpectedly twice within a day while they were on (zysilm.shaderupscale); they apply again after a graphics driver or player update, or in 7 days";
const REFUSED = "Not running: the player ended abnormally while shaders were drawing";
const REFUSED_DETAIL = /^Your choice applies when the player allows shaders again; consider a preset that is not marked demanding\. The player says: /;

/** A player whose crash guard refuses every non-empty list; clearing still works. */
function refusing(host: TestHost, message = CRASH_THIS_START) {
  host.handle("video.shaders.set", (params) => {
    if (Array.isArray(params.paths) && params.paths.length > 0) throw new HostError("previous-crash", message);
    return { state: "applied" };
  });
  return host;
}

/** The non-empty lists the plugin sent: each one is an attempt. */
const attempts = (host: TestHost) => host.sent("video.shaders.set").filter((params) => Array.isArray(params.paths) && params.paths.length > 0);

test("crash safety: a guard.json left by an earlier build is deleted at start and changes nothing", async () => {
  const data = await mkdtemp(join(tmpdir(), "shaderupscale-"));
  await writeFile(join(data, "upscaling.json"), JSON.stringify({ ...DEFAULT_SETTINGS, on: true }));
  await writeFile(join(data, "guard.json"), JSON.stringify({ active: true }));
  const { host, stop } = await start(windowsGpu(), "en", data);
  try {
    host.openElsewhere("/media/clip.mkv");
    await host.settle();
    assert.equal(existsSync(join(data, "guard.json")), false);
    assert.deepEqual(held(host), paths(anime4kFiles("A", "fast")));
    assert.equal(host.osd.length, 0);
  } finally {
    await stop();
  }
});

test("crash safety: the player refuses with previous-crash: the choice is kept, the status says why, no OSD, no retry", async () => {
  const data = await mkdtemp(join(tmpdir(), "shaderupscale-"));
  const choice = { ...DEFAULT_SETTINGS, on: true, anime4k: { mode: "A+A", quality: "hq" } };
  await writeFile(join(data, "upscaling.json"), JSON.stringify(choice));
  const { host, window, stop } = await opened(refusing(windowsGpu(), CRASH_DAYS), "en", data);
  try {
    await eventually(host, () => assert.equal(window.props.status, REFUSED));
    assert.equal(held(host), undefined);
    assert.equal(attempts(host).length, 1);
    // The saved choice, so the button offers Turn Off; no duration of its own: the player's message says how long.
    assert.equal(window.props.on, true);
    assert.equal(window.props["can-toggle"], true);
    assert.equal(window.props.tone, 3);
    assert.match(String(window.props.detail), REFUSED_DETAIL);
    assert.ok(String(window.props.detail).endsWith(CRASH_DAYS));
    // The player shows its own OSD line; the plugin adds none.
    assert.equal(host.osd.length, 0);
    // Nothing tries again by itself: a new video, a new mode, a new quality.
    host.openElsewhere("/media/other.mkv");
    window.emit("pickA", 0);
    window.emit("pickB", 0);
    await host.settle(100);
    assert.equal(attempts(host).length, 1);
    assert.equal(window.props.status, REFUSED);
    assert.equal(host.osd.length, 0);
  } finally {
    await stop();
  }
  // Still on in the settings, with the new choice.
  const settings = await saved(data);
  assert.equal(settings.on, true);
  assert.deepEqual(settings.anime4k, { mode: "A", quality: "fast" });
});

test("crash safety: while refused, Turn Off saves off; Turn On then tries exactly once and shows the same reason", async () => {
  const data = await mkdtemp(join(tmpdir(), "shaderupscale-"));
  await writeFile(join(data, "upscaling.json"), JSON.stringify({ ...DEFAULT_SETTINGS, on: true }));
  const { host, window, stop } = await opened(refusing(windowsGpu()), "en", data);
  try {
    await eventually(host, () => assert.equal(window.props.status, REFUSED));
    window.emit("toggle");
    await eventually(host, async () => {
      assert.equal(window.props.on, false);
      assert.equal(window.props.status, "Off");
      assert.equal(window.props.detail, "");
      assert.deepEqual(host.osd, ["Shader Upscaling: Off"]);
      assert.equal((await saved(data)).on, false);
    });
    assert.equal(attempts(host).length, 1);
    // The explicit Turn On: one attempt, refused again, the same reason, no OSD of the plugin's.
    window.emit("toggle");
    await eventually(host, () => assert.equal(attempts(host).length, 2));
    await host.settle(100);
    assert.equal(attempts(host).length, 2);
    assert.equal(window.props.status, REFUSED);
    assert.equal(window.props.on, true);
    assert.deepEqual(host.osd, ["Shader Upscaling: Off"]);
    assert.equal(held(host), undefined);
    // This stands for the next start, where the player allows shaders again (here: the refusal
    // removed); within one run the player refuses every list, so Turn On cannot get through there.
    host.reset("video.shaders.set");
    window.emit("toggle");
    window.emit("toggle");
    await eventually(host, () => {
      assert.deepEqual(held(host), paths(anime4kFiles("A", "fast")));
      assert.equal(window.props.status, "On: Anime4K mode A (Fast)");
      assert.equal(window.props.detail, "");
      assert.equal(host.osd.at(-1), "Shader Upscaling: On, Anime4K mode A (Fast)");
    });
    assert.equal(attempts(host).length, 3);
  } finally {
    await stop();
  }
});

test("crash safety: refused while off: Turn On is the one attempt, with no OSD and the reason in the status", async () => {
  const { host, window, stop } = await opened(refusing(windowsGpu()));
  try {
    assert.equal(attempts(host).length, 0);
    window.emit("toggle");
    await eventually(host, () => assert.equal(window.props.status, REFUSED));
    await host.settle(100);
    assert.equal(attempts(host).length, 1);
    assert.equal(host.osd.length, 0);
    assert.equal(window.props.on, true);
  } finally {
    await stop();
  }
});

test("crash safety: a stop and wake of the plugin within the player run does not send again; a new player run does", async () => {
  const data = await mkdtemp(join(tmpdir(), "shaderupscale-"));
  await writeFile(join(data, "upscaling.json"), JSON.stringify({ ...DEFAULT_SETTINGS, on: true }));
  const first = await opened(refusing(windowsGpu()), "en", data);
  await eventually(first.host, () => assert.equal(first.window.props.status, REFUSED));
  const session = first.host.sessionStorage;
  await first.stop();
  // Woken in the same player run (lazy activation, a reload): the refusal is remembered.
  const woken = refusing(windowsGpu());
  const { host, stop } = await startPlugin(activate, { directory, host: woken, locale: "en", dataDirectory: data, sessionStorage: session });
  try {
    host.openElsewhere("/media/clip.mkv");
    await host.command(ITEM).run();
    await host.settle(100);
    assert.equal(attempts(host).length, 0);
    assert.equal(host.window("upscale").props.status, REFUSED);
  } finally {
    await stop();
  }
  // A new player run that allows shaders: the saved choice applies.
  const next = await opened(windowsGpu(), "en", data);
  try {
    assert.deepEqual(held(next.host), paths(anime4kFiles("A", "fast")));
  } finally {
    await next.stop();
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

test("macOS: Anime4K, FSR and both add-ons run", async () => {
  const host = new TestHost(); // macOS on the GPU
  const { window, stop } = await opened(host);
  try {
    window.emit("toggle");
    await eventually(host, () => assert.deepEqual(held(host), paths(anime4kFiles("A", "fast"))));
    assert.equal(window.props.status, "On: Anime4K mode A (Fast)");
    window.emit("pickModel", 1);
    window.emit("toggleChroma", true);
    window.emit("toggleSharpen", true);
    await eventually(host, () => assert.deepEqual(held(host), paths([CHROMA_FILE, "fsr/FSR.glsl", SHARPEN_FILE])));
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
    // Mode C (Fast) is five shaders: with fewer held elsewhere (10 + 5) it fits.
    host.videoShaders.others = 10;
    window.emit("pickA", 2);
    await eventually(host, () => {
      assert.deepEqual(held(host), paths(anime4kFiles("C", "fast")));
      assert.equal(window.props.status, "On: Anime4K mode C (Fast)");
    });
    // FSR with both add-ons is three: it fits next to 13 others.
    host.videoShaders.others = 13;
    window.emit("pickModel", 1);
    window.emit("toggleChroma", true);
    window.emit("toggleSharpen", true);
    await eventually(host, () => {
      assert.deepEqual(held(host), paths([CHROMA_FILE, "fsr/FSR.glsl", SHARPEN_FILE]));
      assert.equal(window.props.status, "On: AMD FSR 1 + chroma + sharpen");
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
    assert.deepEqual(window.props.models, ["动画：Anime4K", "通用：AMD FSR 1"]);
    window.emit("toggle");
    await eventually(host, () => {
      assert.equal(window.props.status, "开：Anime4K 模式 A（快速）");
      assert.equal(host.osd.at(-1), "着色器超分辨率：开，Anime4K 模式 A（快速）");
    });
    window.emit("pickModel", 1);
    window.emit("toggleChroma", true);
    window.emit("toggleSharpen", true);
    await eventually(host, () => assert.equal(window.props.status, "开：AMD FSR 1 + 色度 + 锐化"));
  } finally {
    await stop();
  }
});

for (const locale of ["en", "zh-Hans"] as const) {
  test(`${locale}: every OSD line fits the OSD's budget`, async () => {
    const budget = locale === "en" ? OSD_BUDGET.en : OSD_BUDGET.zh;
    // The longest presets and software rendering.
    const gpuRun = await opened(windowsGpu(), locale);
    gpuRun.window.emit("pickA", 3);
    gpuRun.window.emit("pickB", 1);
    gpuRun.window.emit("toggle");
    await eventually(gpuRun.host, () => assert.deepEqual(held(gpuRun.host), paths(anime4kFiles("A+A", "hq"))));
    gpuRun.window.emit("pickA", 5);
    gpuRun.window.emit("toggleChroma", true);
    gpuRun.window.emit("toggleSharpen", true);
    gpuRun.window.emit("toggle");
    gpuRun.window.emit("toggle");
    await eventually(gpuRun.host, () => {
      assert.deepEqual(held(gpuRun.host), paths([CHROMA_FILE, ...anime4kFiles("C+A", "hq"), SHARPEN_FILE]));
      assert.equal(gpuRun.host.osd.length, 3); // on, off, on (the longest name: both add-ons)
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
    assert.ok(lines.length >= 5);
    for (const line of lines) assert.ok(line.length <= budget, `${line.length} > ${budget}: ${line}`);
  });
}

// The longest status line of each language, left in the window when the test ends (`ui:shots` draws that state): the
// longest mode (A+A; B+B and C+A are as long), HQ, both add-ons. It is wider than the room beside the button at 400 px.
const LONGEST_STATUS: Record<Locale, string> = {
  en: "On: Anime4K mode A+A (HQ) + chroma + sharpen",
  "zh-Hans": "开：Anime4K 模式 A+A（高画质） + 色度 + 锐化",
};

for (const locale of ["en", "zh-Hans"] as const) {
  test(`${locale}: the longest status line (Anime4K A+A HQ, both add-ons) is shown whole`, async () => {
    const { host, window, stop } = await opened(windowsGpu(), locale);
    try {
      window.emit("pickA", 3); // A+A
      window.emit("pickB", 1); // HQ
      window.emit("toggleChroma", true);
      window.emit("toggleSharpen", true);
      window.emit("toggle");
      await eventually(host, () => {
        assert.deepEqual(held(host), paths([CHROMA_FILE, ...anime4kFiles("A+A", "hq"), SHARPEN_FILE]));
        assert.equal(window.props.status, LONGEST_STATUS[locale]);
      });
    } finally {
      await stop();
    }
  });
}

test("window: the status line wraps instead of eliding, and the row grows with it", async () => {
  const slint = await readFile(new URL("upscale.slint", directory), "utf8");
  const row = slint.slice(slint.indexOf("// The status line:"), slint.indexOf("if root.detail"));
  const status = row.slice(row.indexOf("text: root.status;"));
  assert.match(status.slice(0, status.indexOf("}")), /wrap: word-wrap;/);
  assert.doesNotMatch(row, /overflow: elide/);
  // A fixed row height would cut the second line off.
  assert.doesNotMatch(row.slice(0, row.indexOf("VerticalLayout")), /height:/);
});

// ------------------------------------------------------------------ the store listing

test("store listing: the id of the directory, the name, a 256×256 icon, the player version", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
  assert.equal(manifest.id, "zysilm.shaderupscale"); // <owner>.<directory>, as the repository requires
  assert.equal(manifest.name, "Shader Upscale for Vestra Player");
  assert.equal(manifest.minPlayerVersion, "0.6.3"); // the shader channel (0.5.20), the Choice drop-down (0.6.0), the crash guard (0.6.3)
  assert.equal(manifest.icon, "assets/icon.png");
  const png = await readFile(new URL(manifest.icon, directory));
  assert.equal(png.toString("latin1", 1, 4), "PNG");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [256, 256]);
});
