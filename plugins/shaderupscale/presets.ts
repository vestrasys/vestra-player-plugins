/**
 * The models and their presets: which bundled shader files each choice runs,
 * in order. Pure data and functions, so the tests can check every preset
 * against the files in `shaders/`.
 */

/** The models the window offers, in its drop-down order. */
export const MODELS = ["anime4k", "artcnn"] as const;
export type ModelId = (typeof MODELS)[number];

/** Anime4K's six modes, as its own mpv templates define them (Anime4K 4.0.1). */
export const ANIME4K_MODES = ["A", "B", "C", "A+A", "B+B", "C+A"] as const;
export type Anime4kMode = (typeof ANIME4K_MODES)[number];

/** Anime4K's two template sets: lower-end GPUs ("Fast", CNN M/S) and higher-end ones ("HQ", CNN VL/M). */
export const ANIME4K_QUALITIES = ["fast", "hq"] as const;
export type Anime4kQuality = (typeof ANIME4K_QUALITIES)[number];

/** ArtCNN's real-time sizes: C4F16 (about 12k parameters) and C4F32 (about 48k). */
export const ARTCNN_SIZES = ["c4f16", "c4f32"] as const;
export type ArtcnnSize = (typeof ARTCNN_SIZES)[number];

/** ArtCNN's variants: neutral, DS (denoise and sharpen), DN (denoise and soften). */
export const ARTCNN_STYLES = ["neutral", "ds", "dn"] as const;
export type ArtcnnStyle = (typeof ARTCNN_STYLES)[number];

/** What the plugin keeps across restarts (`upscaling.json` in its data directory). */
export interface Settings {
  /** The user turned shader upscaling on (and has not turned it off). */
  on: boolean;
  /** The model the window shows and, while on, applies. */
  model: ModelId;
  /** Each model keeps its own parameters, so switching models back finds them as they were. */
  anime4k: { mode: Anime4kMode; quality: Anime4kQuality };
  artcnn: { size: ArtcnnSize; style: ArtcnnStyle };
}

export const DEFAULT_SETTINGS: Settings = {
  on: false,
  model: "anime4k",
  anime4k: { mode: "A", quality: "fast" },
  artcnn: { size: "c4f16", style: "neutral" },
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
  isObject(value.artcnn) &&
  oneOf(ARTCNN_SIZES, value.artcnn.size) &&
  oneOf(ARTCNN_STYLES, value.artcnn.style);

/** The modes with a second restore pass: marked demanding, as HQ and ArtCNN C4F32 are. */
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

/** ArtCNN's one shader for a size and variant (a luma doubler; the player scales the colour planes). */
export function artcnnFiles(size: ArtcnnSize, style: ArtcnnStyle): string[] {
  const suffix = style === "neutral" ? "" : `_${style.toUpperCase()}`;
  return [`artcnn/ArtCNN_${size.toUpperCase()}${suffix}.glsl`];
}

/** The shader files (relative to `shaders/`, with `/`) the settings' model and parameters run, in order. */
export function shaderFiles(settings: Settings): string[] {
  return settings.model === "anime4k"
    ? anime4kFiles(settings.anime4k.mode, settings.anime4k.quality)
    : artcnnFiles(settings.artcnn.size, settings.artcnn.style);
}

/**
 * The model's shaders are compute shaders (`//!COMPUTE`). macOS's OpenGL 4.1
 * has none, so mpv cannot run them there; Direct3D 11 on Windows can.
 */
export const needsCompute = (model: ModelId) => model === "artcnn";
