/**
 * The upscalers, the add-ons and their presets: which bundled shader files
 * each choice runs, in order, on each platform. Pure data and functions, so
 * the tests can check every preset against the files in `shaders/`.
 *
 * Every shader here is a fragment shader for mpv's vo_gpu renderer (the
 * player's libmpv), with no `//!COMPUTE` (macOS draws with OpenGL 4.1) and no
 * `//!PARAM` (the Homebrew mpv 0.41.0 vo_gpu refuses it).
 */

/**
 * The upscalers the window offers, in its drop-down order: Anime4K for anime
 * and cartoons, AMD FSR 1 for everything else (live action, games, mixed),
 * and two for live action (0.3.0): RAVU-lite-AR r3 (light) and FSRCNNX x2
 * (high). FSR, RAVU and FSRCNNX each enlarge the luma plane 2×; being one
 * choice, only one of them runs at a time.
 * ArtCNN (0.1.0) was taken out in 0.1.1: its shaders write the luma plane
 * with four components, which needs mpv's gpu-next renderer; the player's
 * libmpv draws with vo_gpu, where they cost GPU time without taking effect
 * (and compile for about a minute).
 */
export const MODELS = ["anime4k", "fsr", "ravu", "fsrcnnx"] as const;
export type ModelId = (typeof MODELS)[number];

/** Anime4K's six modes, as its own mpv templates define them (Anime4K 4.0.1). */
export const ANIME4K_MODES = ["A", "B", "C", "A+A", "B+B", "C+A"] as const;
export type Anime4kMode = (typeof ANIME4K_MODES)[number];

/**
 * Anime4K's network sizes: lower-end GPUs ("Fast", CNN M/S, upstream's
 * Low-end template), higher-end ones ("HQ", CNN VL/M, the High-end template)
 * and "Ultra" (0.3.0; CNN UL/M, the High-end template with UL in place of
 * VL), about twice HQ's work.
 */
export const ANIME4K_QUALITIES = ["fast", "hq", "ultra"] as const;
export type Anime4kQuality = (typeof ANIME4K_QUALITIES)[number];

/** FSRCNNX's two networks: 16 feature channels (the default, demanding) or 8 (lighter). */
export const FSRCNNX_SIZES = ["16", "8"] as const;
export type FsrcnnxSize = (typeof FSRCNNX_SIZES)[number];

/**
 * Where the player runs, for the files that differ: RAVU's lookup texture is
 * `rgba16hf` on Windows (mpv's vo_gpu with Direct3D 11 has no `rgba16f`) and
 * `rgba16f` elsewhere (macOS, OpenGL 4.1).
 */
export const PLATFORMS = ["windows", "other"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** The platform of an operating system as the player names it (`SystemInfo.os`); an unknown one counts as "other". */
export const platformOf = (os: string | undefined): Platform => (os === "windows" ? "windows" : "other");

/** The most shaders the player runs at once, from all plugins together. */
export const MAX_SHADERS = 16;

/** What the plugin keeps across restarts (`upscaling.json` in its data directory). */
export interface Settings {
  /** The user turned shader upscaling on (and has not turned it off). */
  on: boolean;
  /** The upscaler the window shows and, while on, applies. */
  model: ModelId;
  /** Anime4K's parameters (kept while another upscaler is chosen). */
  anime4k: { mode: Anime4kMode; quality: Anime4kQuality };
  /** FSRCNNX's network (kept while another upscaler is chosen). */
  fsrcnnx: { size: FsrcnnxSize };
  /** Add-on: chroma from luma prediction (CfL) upscales the colour planes (before Anime4K; after FSR, RAVU and FSRCNNX, from their luma). */
  chroma: boolean;
  /** Add-on: adaptive sharpening of the final picture, after the upscaler. */
  sharpen: boolean;
  /** Add-on: SSimDownscaler, when the picture is drawn smaller than the video. */
  downscale: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  on: false,
  model: "anime4k",
  anime4k: { mode: "A", quality: "fast" },
  fsrcnnx: { size: "16" },
  chroma: false,
  sharpen: false,
  downscale: false,
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

const isAnime4k = (value: unknown): value is Settings["anime4k"] =>
  isObject(value) && oneOf(ANIME4K_MODES, value.mode) && oneOf(ANIME4K_QUALITIES, value.quality);

const isFsrcnnx = (value: unknown): value is Settings["fsrcnnx"] => isObject(value) && oneOf(FSRCNNX_SIZES, value.size);

export const isSettings = (value: unknown): value is Settings =>
  isObject(value) &&
  typeof value.on === "boolean" &&
  oneOf(MODELS, value.model) &&
  isAnime4k(value.anime4k) &&
  isFsrcnnx(value.fsrcnnx) &&
  typeof value.chroma === "boolean" &&
  typeof value.sharpen === "boolean" &&
  typeof value.downscale === "boolean" &&
  Object.keys(value).length === 7;

/**
 * A saved `upscaling.json` as the current settings, or `null` when it is
 * neither those nor what an earlier version saved. 0.2.x's settings keep
 * their two add-ons and get FSRCNNX's default network and the downscale
 * add-on off; 0.1.1's get all add-ons off. 0.1.0's ArtCNN choice becomes
 * Anime4K mode A (Fast), the default preset, with on/off kept; its `artcnn`
 * parameters are dropped.
 */
export function readSettings(value: unknown): Settings | null {
  if (isSettings(value)) return value;
  if (!isObject(value) || typeof value.on !== "boolean" || !isObject(value.anime4k)) return null;
  const added = { fsrcnnx: { ...DEFAULT_SETTINGS.fsrcnnx }, downscale: false };
  if (value.model === "artcnn")
    return { on: value.on, model: "anime4k", anime4k: { ...DEFAULT_SETTINGS.anime4k }, ...added, chroma: false, sharpen: false };
  // 0.2.x saved chroma and sharpen; 0.1.1 neither.
  const chroma = value.chroma ?? false;
  const sharpen = value.sharpen ?? false;
  const current = { on: value.on, model: value.model, anime4k: value.anime4k, ...added, chroma, sharpen };
  // Earlier versions offered only Anime4K and FSR, with Fast and HQ.
  const earlier = (value.model === "anime4k" || value.model === "fsr") && value.anime4k.quality !== "ultra";
  return earlier && isSettings(current) ? current : null;
}

/** What the store accepts: current settings, or an earlier version's to be migrated with {@link readSettings}. */
export const isStoredSettings = (value: unknown): value is Settings => readSettings(value) !== null;

/** The modes with a second restore pass: marked demanding, as HQ and Ultra are. */
export const demandingMode = (mode: Anime4kMode) => mode.includes("+");

/** A file of Anime4K's under `shaders/anime4k/`. */
const a4k = (name: string) => `anime4k/Anime4K_${name}.glsl`;

/**
 * Anime4K's shader chain for a mode, exactly as the upstream mpv templates
 * (`md/Template/GLSL_Mac_Linux_{High,Low}-end/input.conf` on the master
 * branch; the v4.0.1 tag does not contain them) list it. "HQ" uses the VL
 * network for the first steps and M for the last; "Fast" uses M and S.
 * "Ultra" is the High-end template with UL in place of VL: upstream ships
 * the UL networks without a template of their own and says the CNN variant
 * "can be chosen at will" (`md/GLSL_Instructions_Advanced.md`); the last
 * steps stay M. The two AutoDownscalePre passes only run when the picture
 * would otherwise be upscaled past the window, so the chain fits any window
 * size.
 */
export function anime4kFiles(mode: Anime4kMode, quality: Anime4kQuality): string[] {
  const big = { fast: "M", hq: "VL", ultra: "UL" }[quality];
  const small = quality === "fast" ? "S" : "M";
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
 * RAVU-lite-AR r3 (bjin's mpv-prescalers, LGPL-3.0): two fragment passes on
 * the luma plane, a 2× enlargement learned from video, with libplacebo's
 * anti-ringing; runs only when the video is enlarged by more than √2. The
 * `gather/` variant (textureGather, upstream's first recommendation for luma
 * prescalers), unchanged: from the `rgba16hf` branch on Windows (mpv's vo_gpu
 * with Direct3D 11 refuses `rgba16f`), from `master` elsewhere.
 */
export const RAVU_FILES: Record<Platform, string> = {
  windows: "ravu/rgba16hf/gather/ravu-lite-ar-r3.hook",
  other: "ravu/master/gather/ravu-lite-ar-r3.hook",
};

/**
 * FSRCNNX x2 (igv, LGPL-3.0, release 1.1): a small convolutional network that
 * enlarges the luma plane 2× (16 or 8 feature channels: 26 or 14 fragment
 * passes); runs only when the video is enlarged by more than 1.3.
 */
export const fsrcnnxFile = (size: FsrcnnxSize) => `fsrcnnx/FSRCNNX_x2_${size}-0-4-1.glsl`;

/** FSRCNNX x2 16 is marked demanding; x2 8 is the lighter choice. */
export const demandingFsrcnnx = (size: FsrcnnxSize) => size === "16";

/**
 * Chroma from luma prediction, Lite (Artoriuz): upscales the colour planes of
 * 4:2:0 and 4:2:2 video guided by the luma plane. Runs only when the chroma
 * is smaller than the luma, so it does nothing for 4:4:4 and RGB video.
 */
export const CHROMA_FILE = "cfl/CfL_Prediction_Lite.glsl";

/** Adaptive sharpen (bacondither, igv's mpv port): one pass on the final picture at window size. */
export const SHARPEN_FILE = "adaptive-sharpen/adaptive-sharpen.glsl";

/**
 * SSimDownscaler (igv, LGPL-3.0): four fragment passes after mpv's scaler
 * (POSTKERNEL) that keep detail and contrast when the picture is drawn
 * smaller than the video (a video larger than the window); they do nothing
 * otherwise.
 */
export const DOWNSCALE_FILE = "ssim-downscaler/SSimDownscaler.glsl";

/** The upscaler's own files, in order. */
export function upscalerFiles(settings: Settings, platform: Platform): string[] {
  switch (settings.model) {
    case "fsr":
      return [...FSR_FILES];
    case "ravu":
      return [RAVU_FILES[platform]];
    case "fsrcnnx":
      return [fsrcnnxFile(settings.fsrcnnx.size)];
    case "anime4k":
      return anime4kFiles(settings.anime4k.mode, settings.anime4k.quality);
  }
}

/**
 * The shader files (relative to `shaders/`, with `/`) the settings run on a
 * platform, in order: the chroma add-on, the upscaler, the downscale add-on,
 * the sharpen add-on. mpv runs each at its own hook point, not in list
 * order: the plane hooks in plane order (LUMA, then CHROMA), then MAIN, then
 * POSTKERNEL (after mpv's scaler), then OUTPUT. So FSR, RAVU and FSRCNNX
 * (LUMA) run before CfL (CHROMA), which then predicts the colour from their
 * enlarged luma; CfL runs before Anime4K (MAIN); SSimDownscaler follows
 * mpv's scaler; sharpen (OUTPUT) always runs last.
 */
export function shaderFiles(settings: Settings, platform: Platform): string[] {
  return [
    ...(settings.chroma ? [CHROMA_FILE] : []),
    ...upscalerFiles(settings, platform),
    ...(settings.downscale ? [DOWNSCALE_FILE] : []),
    ...(settings.sharpen ? [SHARPEN_FILE] : []),
  ];
}
