import type { Plugin } from "@vestra-player/sdk";
import bufferutil from "bufferutil";

/** A native module (binding.gyp, prebuilt .node files): refused. */
export default async function activate(_plugin: Plugin) {
  console.log(typeof bufferutil);
}
