// The part of ONNX Runtime Web's API (onnxruntime-web 1.31.1, types.d.ts) that tagger-worker.ts uses.
// Written for this plugin; the JavaScript beside it is the unchanged upstream file.

export declare class Tensor {
  constructor(type: "float32", data: Float32Array, dims: readonly number[]);
  readonly dims: readonly number[];
  readonly data: Float32Array | Int32Array | Uint8Array;
}

export interface SessionOptions {
  graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
  executionMode?: "sequential" | "parallel";
}

export declare class InferenceSession {
  static create(model: Uint8Array, options?: SessionOptions): Promise<InferenceSession>;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor | undefined>>;
  release(): Promise<void>;
}

export declare const env: {
  wasm: {
    numThreads?: number;
    wasmBinary?: ArrayBuffer | Uint8Array;
  };
};
