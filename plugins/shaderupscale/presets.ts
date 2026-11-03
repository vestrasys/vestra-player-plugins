/**
 * The upscalers, the two add-ons and their presets: which bundled shader
 * files each choice runs, in order. Pure data and functions, so the tests can
 * check every preset against the files in `shaders/`.
 *
 * Every shader here is a fragment shader for mpv's vo_gpu renderer (the
 * player's libmpv), with no `//!COMPUTE` (macOS draws with OpenGL 4.1) and no
 * `//!PARAM` (the Homebrew mpv 0.41.0 vo_gpu refuses it).
 */

/**
 * The upscalers the window offers, in its drop-down order: Anime4K for anime
 * and cartoons, AMD FSR 1 for everything else (live action, games, mixed).
 * ArtCNN (0.1.0) was taken out in 0.1.1: its shaders write the luma plane
 * with four components, which needs mpv's gpu-next renderer; the player's
 * libmpv draws with vo_gpu, where they cost GPU time without taking effect
 * (and compile for about a minute).
 */
export const MODELS = ["anime4k", "fsr"] as const;
export type ModelId = (typeof MODELS)[number];

/** Anime4K's six modes, as its own mpv templates define them (Anime4K 4.0.1). */
export const ANIME4K_MODES = ["A", "B", "C", "A+A", "B+B", "C+A"] as const;
export type Anime4kMode = (typeof ANIME4K_MODES)[number];

/** Anime4K's two template sets: lower-end GPUs ("Fast", CNN M/S) and higher-end ones ("HQ", CNN VL/M). */
export const ANIME4K_QUALITIES = ["fast", "hq"] as const;
export type Anime4kQuality = (typeof ANIME4K_QUALITIES)[number];

/** The most shaders the player runs at once, from all plugins together. */
export const MAX_SHADERS = 16;

/** What the plugin keeps across restarts (`upscaling.json` in its data directory). */
export interface Settings {
  /** The user turned shader upscaling on (and has not turned it off). */
  on: boolean;
  /** The upscaler the window shows and, while on, applies. */
  model: ModelId;
  /** Anime4K's parameters (kept while FSR is chosen). */
  anime4k: { mode: Anime4kMode; quality: Anime4kQuality };
  /** Add-on: chroma from luma prediction (CfL) upscales the colour planes, before the upscaler. */
  chroma: boolean;
  /** Add-on: adaptive sharpening of the final picture, after the upscaler. */
  sharpen: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  on: false,
  model: "anime4k",
  anime4k: { mode: "A", quality: "fast" },
  chroma: false,
  sharpen: false,
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

const isAnime4k = (value: unknown): value is Settings["anime4k"] =>
  isObject(value) && oneOf(ANIME4K_MODES, value.mode) && oneOf(ANIME4K_QUALITIES, value.quality);

export const isSettings = (value: unknown): value is Settings =>
  isObject(value) &&
  typeof value.on === "boolean" &&
  oneOf(MODELS, value.model) &&
  isAnime4k(value.anime4k) &&
  typeof value.chroma === "boolean" &&
  typeof value.sharpen === "boolean" &&
  Object.keys(value).length === 5;

/**
 * A saved `upscaling.json` as the current settings, or `null` when it is
 * neither those nor what an earlier version saved. 0.1.1's settings get both
 * add-ons off. 0.1.0's ArtCNN choice becomes Anime4K mode A (Fast), the
 * default preset, with on/off kept; its `artcnn` parameters are dropped.
 */
export function readSettings(value: unknown): Settings | null {
  if (isSettings(value)) return value;
  if (!isObject(value) || typeof value.on !== "boolean" || !isObject(value.anime4k)) return null;
  const addOns = { chroma: false, sharpen: false };
  if (value.model === "artcnn") return { on: value.on, model: "anime4k", anime4k: { ...DEFAULT_SETTINGS.anime4k }, ...addOns };
  const current = { on: value.on, model: value.model, anime4k: value.anime4k, ...addOns };
  return isSettings(current) ? current : null;
}

/** What the store accepts: current settings, or an earlier version's to be migrated with {@link readSettings}. */
export const isStoredSettings = (value: unknown): value is Settings => readSettings(value) !== null;

/** The modes with a second restore pass: marked demanding, as HQ is. */
export const demandingMode = (mode: Anime4kMode) => mode.includes("+");

/** A file of Anime4K's under `shaders/anime4k/`. */
const a4k = (name: string) => `anime4k/Anime4K_${name}.glsl`;

/**
 * Anime4K's shader chain for a mode, exactly as the upstream mpv templates
 * (`md/Template/GLSL_Mac_Linux_{High,Low}-end/input.conf` on the master
 * branch; the v4.0.1 tag does not contain them) list it. "HQ"
 * uses the VL network for the first steps and M for the last; "Fast" uses M
 * and S. The two AutoDownscalePre passes only run when the picture would
 * otherwise be upscaled past the window, so the chain fits any window size.
 */
export function anime4kFiles(mode: Anime4kMode, quality: Anime4kQuality): string[] {
  const big = quality === "hq" ? "VL" : "M";
  const small = quality === "hq" ? "M" : "S";
  const clamp = a4k("Clamp_Highlights");
  const down = [a4k("AutoDownscalePre_x2"), a4k("AutoDownscalePre_x4")];
  const last = a4k(`Upscale_CNN_x2_${small}`);
  switch (mode) {
    case "A":
      return [clamp, a4k(`Restore_CNN_${big}`), a4k(`Upscale_CNN_x2_${big}`), ...down, last];
    case "B":
      return [clamp, a4k(`Restore_CNN_Soft_${big}`), a4k(`Upscale_CNN_x2_${big}`), ...down, last];
    case "C":
      return [clamp, a4k(`Upscale_Denoise_CNN_x2_${big}`), ...down, last];
    case "A+A":
      return [clamp, a4k(`Restore_CNN_${big}`), a4k(`Upscale_CNN_x2_${big}`), a4k(`Restore_CNN_${small}`), ...down, last];
    case "B+B":
      return [clamp, a4k(`Restore_CNN_Soft_${big}`), a4k(`Upscale_CNN_x2_${big}`), ...down, a4k(`Restore_CNN_Soft_${small}`), last];
    case "C+A":
      return [clamp, a4k(`Upscale_Denoise_CNN_x2_${big}`), ...down, a4k(`Restore_CNN_${small}`), last];
  }
}

/**
 * AMD FidelityFX Super Resolution 1.0.2 in agyild's mpv port: one file, two
 * fragment passes on the luma plane, EASU (edge-adaptive upscaling, up to 2×
 * per side; mpv's scaler does the rest) and RCAS (sharpening). It runs only
 * when the video is enlarged.
 */
export const FSR_FILES = ["fsr/FSR.glsl"];

/**
 * Chroma from luma prediction, Lite (Artoriuz): upscales the colour planes of
 * 4:2:0 and 4:2:2 video guided by the luma plane. Runs only when the chroma
 * is smaller than the luma, so it does nothing for 4:4:4 and RGB video.
 */
export const CHROMA_FILE = "cfl/CfL_Prediction_Lite.glsl";

/** Adaptive sharpen (bacondither, igv's mpv port): one pass on the final picture at window size. */
export const SHARPEN_FILE = "adaptive-sharpen/adaptive-sharpen.glsl";

/** The upscaler's own files, in order. */
export function upscalerFiles(settings: Settings): string[] {
  return settings.model === "fsr" ? [...FSR_FILES] : anime4kFiles(settings.anime4k.mode, settings.anime4k.quality);
}

/**
 * The shader files (relative to `shaders/`, with `/`) the settings run, in
 * order: the chroma add-on, the upscaler, the sharpen add-on. mpv runs each
 * at its own hook point (CHROMA, then LUMA or MAIN, then OUTPUT), so the
 * order only documents the flow of the picture.
 */
export function shaderFiles(settings: Settings): string[] {
  return [...(settings.chroma ? [CHROMA_FILE] : []), ...upscalerFiles(settings), ...(settings.sharpen ? [SHARPEN_FILE] : [])];
}

