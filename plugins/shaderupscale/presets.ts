/**
 * The models and their presets: which bundled shader files each choice runs,
 * in order. Pure data and functions, so the tests can check every preset
 * against the files in `shaders/`.
 */

/**
 * The models the window offers, in its drop-down order (the window shows the
 * drop-down only with more than one). ArtCNN (0.1.0) was taken out in 0.1.1: its
 * shaders write the luma plane with four components, which needs mpv's
 * gpu-next renderer; the player's libmpv draws with vo_gpu, where they cost
 * GPU time without taking effect (and compile for about a minute).
 */
export const MODELS = ["anime4k"] as const;
export type ModelId = (typeof MODELS)[number];

/** Anime4K's six modes, as its own mpv templates define them (Anime4K 4.0.1). */
export const ANIME4K_MODES = ["A", "B", "C", "A+A", "B+B", "C+A"] as const;
export type Anime4kMode = (typeof ANIME4K_MODES)[number];

/** Anime4K's two template sets: lower-end GPUs ("Fast", CNN M/S) and higher-end ones ("HQ", CNN VL/M). */
export const ANIME4K_QUALITIES = ["fast", "hq"] as const;
export type Anime4kQuality = (typeof ANIME4K_QUALITIES)[number];

/** What the plugin keeps across restarts (`upscaling.json` in its data directory). */
export interface Settings {
  /** The user turned shader upscaling on (and has not turned it off). */
  on: boolean;
  /** The model the window shows and, while on, applies. */
  model: ModelId;
  /** The model's parameters. */
  anime4k: { mode: Anime4kMode; quality: Anime4kQuality };
}

export const DEFAULT_SETTINGS: Settings = {
  on: false,
  model: "anime4k",
  anime4k: { mode: "A", quality: "fast" },
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

export const isSettings = (value: unknown): value is Settings =>
  isObject(value) &&
  typeof value.on === "boolean" &&
  oneOf(MODELS, value.model) &&
  isObject(value.anime4k) &&
  oneOf(ANIME4K_MODES, value.anime4k.mode) &&
  oneOf(ANIME4K_QUALITIES, value.anime4k.quality) &&
  Object.keys(value).length === 3;

/**
 * A saved `upscaling.json` as the current settings, or `null` when it is
 * neither those nor what 0.1.0 saved. 0.1.0's ArtCNN choice becomes Anime4K
 * mode A (Fast), the default preset, with on/off kept; its `artcnn`
 * parameters are dropped.
 */
export function readSettings(value: unknown): Settings | null {
  if (isSettings(value)) return value;
  if (!isObject(value) || typeof value.on !== "boolean" || !isObject(value.anime4k)) return null;
  if (value.model === "artcnn") return { on: value.on, model: "anime4k", anime4k: { ...DEFAULT_SETTINGS.anime4k } };
  const current = { on: value.on, model: value.model, anime4k: value.anime4k };
  return isSettings(current) ? current : null;
}

/** What the store accepts: current settings, or 0.1.0's to be migrated with {@link readSettings}. */
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

/** The shader files (relative to `shaders/`, with `/`) the settings' model and parameters run, in order. */
export function shaderFiles(settings: Settings): string[] {
  return anime4kFiles(settings.anime4k.mode, settings.anime4k.quality);
}
