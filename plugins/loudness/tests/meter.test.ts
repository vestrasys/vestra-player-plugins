import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY, FILTER, format, level, readMetadata } from "../meter.ts";

test("the filter is one labelled lavfi ebur128 with metadata and true peak", () => {
  assert.equal(FILTER, "@loudness:lavfi=[ebur128=metadata=1:peak=true]");
});

test("metadata: silence is no value, the peak is the highest channel, every value is the filter's own", () => {
  const first = readMetadata(
    {
      "lavfi.r128.M": "-120.691",
      "lavfi.r128.S": "-70.000",
      "lavfi.r128.I": "-70.000",
      "lavfi.r128.LRA": "0.000",
      "lavfi.r128.true_peaks_ch0": "0.000",
      "lavfi.r128.true_peaks_ch1": "0.500",
    },
    EMPTY,
  );
  assert.equal(first.truePeak?.toFixed(2), "-6.02", "linear 0.5 is −6.02 dBTP");
  assert.deepEqual({ ...first, truePeak: 0 }, { momentary: null, shortTerm: null, integrated: null, range: 0, truePeak: 0, seen: true });
  const second = readMetadata({ "lavfi.r128.M": -20, "lavfi.r128.true_peak": 0.25 }, first);
  assert.equal(second.truePeak?.toFixed(2), "-12.04", "the peak is the filter's own: a new filter's lower one replaces it");
  assert.equal(second.integrated, null, "nothing carried over from the previous filter");
  assert.equal(readMetadata({ "lavfi.r128.M": "-20", "lavfi.r128.true_peak": "0.000" }, EMPTY).truePeak, null, "silence has no peak");
  assert.equal(second.momentary, -20);
  // Not the filter's tags: the readings stay.
  assert.equal(readMetadata(null, second), second);
  assert.equal(readMetadata({ "lavfi.other": "1" }, second), second);
  assert.equal(readMetadata([1, 2], second), second);
});

test("format and level", () => {
  assert.equal(format(null), "—");
  assert.equal(format(-23.04), "−23.0");
  assert.equal(format(-0.04), "0.0");
  assert.equal(format(6.25), "6.3");
  assert.equal(level(null), 0);
  assert.equal(level(-59), 0);
  assert.equal(level(-5), 1);
  assert.equal(level(0), 1);
  assert.equal(level(-32), 0.5);
});
