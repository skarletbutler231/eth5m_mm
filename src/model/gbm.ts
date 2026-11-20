// A LightGBM regression model, evaluated in-process. The model is LightGBM's dump_model() flattened by
// tools/flowfv/export_model.py ("gbm-compact-1"): per tree, flat arrays over its split nodes, children >= 0 = split
// node, < 0 = leaf ~c. The prediction is the sum of one leaf value per tree; LightGBM folds the training mean into the
// first tree, so there is no separate init score. Numerical "<=" splits only, with LightGBM's missing-value rules
// (Tree::NumericalDecision): NaN counts as 0 unless the split's missing type is NaN; a missing value (NaN for type NaN,
// |x| <= 1e-35 for type Zero) goes to the default side.
import fs from "node:fs";

interface Tree { root: number; f: number[]; t: number[]; d: number[]; m: number[]; l: number[]; r: number[]; v: number[] }
export interface GbmFile { format: string; features: string[]; horizon_s?: number; target?: string; tag?: string; trees: Tree[] }

const K_ZERO = 1e-35;

export class Gbm {
  readonly features: string[];
  readonly horizonS: number | null;
  readonly tag: string | null;
  private trees: { root: number; f: Int32Array; t: Float64Array; d: Uint8Array; m: Uint8Array; l: Int32Array; r: Int32Array; v: Float64Array }[];

  constructor(file: GbmFile) {
    if (file.format !== "gbm-compact-1") throw new Error(`unknown model format ${file.format}`);
    this.features = file.features; this.horizonS = file.horizon_s ?? null; this.tag = file.tag ?? null;
    this.trees = file.trees.map((t) => ({ root: t.root, f: Int32Array.from(t.f), t: Float64Array.from(t.t), d: Uint8Array.from(t.d),
      m: Uint8Array.from(t.m), l: Int32Array.from(t.l), r: Int32Array.from(t.r), v: Float64Array.from(t.v) }));
    for (const t of this.trees) for (const f of t.f) if (f < 0 || f >= this.features.length) throw new Error("model references a missing feature");
  }

  static load(path: string): Gbm { return new Gbm(JSON.parse(fs.readFileSync(path, "utf8")) as GbmFile); }

  get nTrees(): number { return this.trees.length; }

  /** x in the model's feature order; NaN = missing. */
  predict(x: ArrayLike<number>): number {
    let s = 0;
    for (const t of this.trees) {
      let k = t.root;
      while (k >= 0) {
        let v = x[t.f[k]];
        const mt = t.m[k];
        if (Number.isNaN(v) && mt !== 2) v = 0;
        if ((mt === 1 && Math.abs(v) <= K_ZERO) || (mt === 2 && Number.isNaN(v))) k = t.d[k] ? t.l[k] : t.r[k];
        else k = v <= t.t[k] ? t.l[k] : t.r[k];
      }
      s += t.v[~k];
    }
    return s;
  }
}
