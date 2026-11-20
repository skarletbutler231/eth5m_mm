# LightGBM dump_model JSON (+ our "ffv" block) -> the compact model src/model/gbm.ts loads.
# Each tree is flat arrays over its split nodes: f feature index, t threshold, d default_left, m missing type
# (0 None, 1 Zero, 2 NaN), l / r children (>= 0 a split node, < 0 the leaf ~c), and v the leaf values.
# Usage: python3 export_model.py IN.json OUT.json
import json, sys
src, dst = sys.argv[1], sys.argv[2]
j = json.load(open(src))
MT = {"None": 0, "Zero": 1, "NaN": 2}
trees = []
for ti in j["tree_info"]:
    f, t, d, m, l, r, v = [], [], [], [], [], [], []
    def walk(n):
        if "leaf_value" in n or "split_index" not in n:
            v.append(n.get("leaf_value", 0.0)); return ~(len(v) - 1)
        if n.get("decision_type", "<=") != "<=": raise SystemExit("only numerical <= splits are supported")
        k = len(f)
        f.append(n["split_feature"]); t.append(n["threshold"]); d.append(1 if n["default_left"] else 0); m.append(MT[n["missing_type"]])
        l.append(0); r.append(0)
        l[k] = walk(n["left_child"]); r[k] = walk(n["right_child"])
        return k
    root = walk(ti["tree_structure"])
    trees.append({"root": root, "f": f, "t": t, "d": d, "m": m, "l": l, "r": r, "v": v})
ffv = j.get("ffv", {})
out = {"format": "gbm-compact-1", "features": ffv.get("features", j["feature_names"]), "horizon_s": ffv.get("horizon_s"),
       "target": ffv.get("target"), "tag": ffv.get("tag"), "trees": trees}
assert out["features"] == j["feature_names"], "feature list mismatch"
json.dump(out, open(dst, "w"), separators=(",", ":"))
print(f"{len(trees)} trees, {sum(len(x['f']) for x in trees)} splits, {len(out['features'])} features -> {dst}")
