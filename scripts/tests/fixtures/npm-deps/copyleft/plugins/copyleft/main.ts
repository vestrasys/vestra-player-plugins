import type { Plugin } from "@vestra-player/sdk";
import { Chessground } from "chessground";

/** Bundling this would ship GPL code; the rules refuse it before install. */
export default async function activate(_plugin: Plugin) {
  console.log(typeof Chessground);
}
