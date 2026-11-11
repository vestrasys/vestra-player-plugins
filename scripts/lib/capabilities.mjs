/**
 * Capabilities only the player's built-in plugins may declare
 * (`commands.run`, `palette.lead`, ...). Every plugin in this repository is
 * a third-party plugin (scripts/lib/registry.mjs), so a manifest that
 * declares one is refused here as well as by the player and by
 * `vestra-plugin check`.
 *
 * The list is the SDK's: `CAPABILITY_INFO` from `@vestra-player/sdk/testing`,
 * whose entries carry `builtinOnly` since SDK 1.7.9 (copied from the
 * player's capability table). It is imported when asked for, not at load
 * time, so scripts that run without node_modules (the pull request form of
 * scripts/check-registry.mjs) can still import the modules that use it.
 */

/** The builtin-only capability names, from the installed SDK. */
export async function builtinOnlyCapabilities() {
  const { CAPABILITY_INFO } = await import("@vestra-player/sdk/testing");
  const entries = Object.entries(CAPABILITY_INFO ?? {});
  if (!entries.length || entries.some(([, info]) => !("builtinOnly" in info)))
    throw new Error(
      "@vestra-player/sdk has no builtinOnly flag in CAPABILITY_INFO; it must be 1.7.9 or later (npm ci)",
    );
  return new Set(
    entries.filter(([, info]) => info.builtinOnly).map(([name]) => name),
  );
}

/**
 * Problems with a third-party plugin's manifest declaring builtin-only
 * capabilities (empty: none declared). `where` names the manifest in the
 * message; `builtinOnly` is the set from `builtinOnlyCapabilities`.
 */
export function builtinOnlyProblems(manifest, where, builtinOnly) {
  const declared = Array.isArray(manifest?.capabilities)
    ? manifest.capabilities
    : [];
  return declared
    .filter((capability) => builtinOnly.has(capability))
    .map(
      (capability) =>
        `${where}: capability "${capability}" is for the player's built-in plugins only; a third-party plugin cannot declare it`,
    );
}
