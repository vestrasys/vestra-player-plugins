import type { Plugin } from "@vestra-player/sdk";
import escapeStringRegexp from "escape-string-regexp";

/** Uses its one npm dependency, so that the bundle has to include it. */
export default async function activate(_plugin: Plugin) {
  const pattern = new RegExp(`^${escapeStringRegexp("a.b*c")}$`);
  console.log(`fixture pattern ${pattern.source}`);
}
