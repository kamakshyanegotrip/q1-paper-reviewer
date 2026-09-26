"""Q1 Review Engine - statistics service (Phase F, "Mode B": manuscript + raw dataset).

POST /analyze (multipart): file=<csv|xlsx|sav>, spec=<json string>
  spec = {"method": "PLS"|"CB"|"AUTO", "bootstrap": 500,
          "constructs": [{"name": "Service quality", "items": ["SQ1", ...]}],   # optional (auto-mapped otherwise)
          "hint_items": [{"construct": "...", "item": "SQ1"}],                      # item labels seen in the paper's tables
          "paths": [{"from": "...", "to": "...", "hypothesis": "H1"}],
          "indirect": [{"x": "...", "m": "...", "y": "...", "hypothesis": "H4"}],
          "reported": {...structured statistics extracted from the manuscript...},
          "reported_n": 412}
Returns reproduced statistics plus a reported-vs-reproduced comparison. No data is stored.
"""
import io, json, math, os, re, tempfile
import numpy as np
import pandas as pd
from scipy import optimize, stats
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

TOKEN = os.environ.get("Q1_STATS_TOKEN", "")
app = FastAPI(title="Q1 stats service", version="1.0")


# ---------------------------------------------------------------- helpers
def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()

STOP = {"of", "the", "and", "to", "in", "for", "on", "a", "an", "hospital", "perceived"}

def initials(name):
    return "".join(w[0] for w in norm(name).split() if w not in STOP)

def r3(x):
    return None if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))) else round(float(x), 3)

def load_table(raw: bytes, filename: str) -> pd.DataFrame:
    ext = (filename or "").lower().rsplit(".", 1)[-1]
    if ext in ("xlsx", "xls"):
        return pd.read_excel(io.BytesIO(raw))
    if ext in ("sav", "zsav"):
        import pyreadstat
        with tempfile.NamedTemporaryFile(suffix="." + ext, delete=False) as t:
            t.write(raw); path = t.name
        try:
            df, _ = pyreadstat.read_sav(path)
        finally:
            os.unlink(path)
        return df
    text = raw.decode("utf-8-sig", errors="replace")
    sep = ";" if text.count(";") > text.count(",") else ("\t" if text.count("\t") > text.count(",") else ",")
    return pd.read_csv(io.StringIO(text), sep=sep)


# ---------------------------------------------------------------- column mapping
def map_constructs(df, spec, warnings):
    cols = [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])]
    ncol = {norm(c).replace(" ", ""): c for c in cols}
    names = [c.get("name") for c in spec.get("constructs", []) if c.get("name")]
    names += [h.get("construct") for h in spec.get("hint_items", []) if h.get("construct")]
    names = list(dict.fromkeys([n for n in names if n]))
    out = {}
    # 1) explicit items
    for c in spec.get("constructs", []):
        items = [ncol.get(norm(i).replace(" ", "")) for i in c.get("items", [])]
        items = [i for i in items if i]
        if len(items) >= 1:
            out[c["name"]] = items
    # 2) item labels from the paper's loadings table
    for h in spec.get("hint_items", []):
        col = ncol.get(norm(h.get("item")).replace(" ", ""))
        if col and h.get("construct"):
            out.setdefault(h["construct"], [])
            if col not in out[h["construct"]]:
                out[h["construct"]].append(col)
    # 3) prefix groups (SQ1, SQ2 ...) matched to construct initials / names
    groups = {}
    for c in cols:
        m = re.match(r"^([A-Za-z_]+?)[_\-.]?\d+[a-zA-Z]?$", str(c).strip())
        if m:
            groups.setdefault(m.group(1).lower().rstrip("_"), []).append(c)
    used = {i for v in out.values() for i in v}
    for n in names:
        if n in out and len(out[n]) >= 2:
            continue
        ini, nn = initials(n), norm(n).replace(" ", "")
        best = None
        for pfx, items in groups.items():
            own = set(out.get(n, []))
            if any(i in used and i not in own for i in items) or len(items) < 2:
                continue
            if pfx == ini or pfx == nn or (len(pfx) >= 3 and (nn.startswith(pfx) or pfx in nn)):
                best = items; break
        if best:
            out[n] = list(dict.fromkeys(out.get(n, []) + best)); used.update(best)
    missing = [n for n in names if n not in out]
    if missing:
        warnings.append("Could not find dataset columns for: " + ", ".join(missing) + ". Name item columns like the paper's tables (e.g. SQ1, SQ2) to include them.")
    return {k: v for k, v in out.items() if v}


def match_construct(name, constructs):
    n = norm(name)
    for c in constructs:
        if norm(c) == n:
            return c
    for c in constructs:
        cn = norm(c)
        if cn and (cn in n or n in cn):
            return c
    ini = initials(name)
    for c in constructs:
        if initials(c) == ini and ini:
            return c
    return None


# ---------------------------------------------------------------- measurement statistics
def cronbach_alpha(X):
    k = X.shape[1]
    if k < 2:
        return None
    var_items = X.var(axis=0, ddof=1).sum()
    var_total = X.sum(axis=1).var(ddof=1)
    return k / (k - 1) * (1 - var_items / var_total) if var_total > 0 else None

def cr_ave(loadings):
    l = np.asarray(loadings, float)
    if len(l) < 1:
        return None, None
    cr = l.sum() ** 2 / (l.sum() ** 2 + (1 - l ** 2).sum())
    return cr, float((l ** 2).mean())

def htmt(R, items, a, b):
    ia, ib = items[a], items[b]
    het = R.loc[ia, ib].abs().values.mean()
    def mono(ii):
        if len(ii) < 2:
            return 1.0
        sub = R.loc[ii, ii].abs().values
        return sub[np.triu_indices(len(ii), 1)].mean()
    return het / math.sqrt(mono(ia) * mono(ib))


# ---------------------------------------------------------------- PLS-SEM (path weighting, mode A)
def pls(Z, blocks, paths, max_iter=300, tol=1e-7):
    names = list(blocks)
    W = {n: np.ones(len(blocks[n])) for n in names}
    adj = {n: set() for n in names}
    for a, b in paths:
        adj[a].add(b); adj[b].add(a)
    def scores(W):
        S = {}
        for n in names:
            s = Z[blocks[n]].values @ W[n]
            S[n] = (s - s.mean()) / s.std(ddof=0)
        return S
    for _ in range(max_iter):
        Y = scores(W)
        inner = {}
        for n in names:
            v = np.zeros(len(Z))
            preds = [a for a, b in paths if b == n]
            succs = [b for a, b in paths if a == n]
            if preds:
                X = np.column_stack([Y[p] for p in preds])
                coef = np.linalg.lstsq(X, Y[n], rcond=None)[0]
                v += X @ coef
            for s in succs:
                v += np.corrcoef(Y[n], Y[s])[0, 1] * Y[s]
            if not preds and not succs:
                v = Y[n]
            inner[n] = v
        newW = {}
        for n in names:
            X = Z[blocks[n]].values
            w = X.T @ inner[n] / len(Z)
            s = X @ w
            newW[n] = w / s.std(ddof=0)
        diff = max(np.abs(newW[n] - W[n]).max() for n in names)
        W = newW
        if diff < tol:
            break
    Y = scores(W)
    load = {n: [float(np.corrcoef(Z[i], Y[n])[0, 1]) for i in blocks[n]] for n in names}
    beta, r2, vif = {}, {}, {}
    for n in names:
        preds = [a for a, b in paths if b == n]
        if not preds:
            continue
        X = np.column_stack([Y[p] for p in preds])
        coef = np.linalg.lstsq(X, Y[n], rcond=None)[0]
        for p, c in zip(preds, coef):
            beta[(p, n)] = float(c)
        r2[n] = float(1 - ((Y[n] - X @ coef) ** 2).sum() / (Y[n] ** 2).sum())
        if len(preds) > 1:
            Rx = np.corrcoef(X, rowvar=False)
            inv = np.linalg.inv(Rx)
            for p, d in zip(preds, np.diag(inv)):
                vif[(p, n)] = float(d)
        else:
            vif[(preds[0], n)] = 1.0
    return {"scores": Y, "loadings": load, "beta": beta, "r2": r2, "vif": vif}


# ---------------------------------------------------------------- CFA (maximum likelihood) for CB-SEM papers
def cfa(S, n, blocks):
    names = list(blocks)
    items = [i for c in names for i in blocks[c]]
    p, k = len(items), len(names)
    idx = {i: j for j, i in enumerate(items)}
    Sm = S.loc[items, items].values
    nl, nth, nphi = p, p, k * (k - 1) // 2
    def unpack(x):
        L = np.zeros((p, k))
        pos = 0
        for ci, c in enumerate(names):
            for i in blocks[c]:
                L[idx[i], ci] = x[pos]; pos += 1
        th = np.exp(x[pos:pos + p]); pos += p
        Phi = np.eye(k)
        iu = np.triu_indices(k, 1)
        Phi[iu] = np.tanh(x[pos:pos + nphi]); Phi[(iu[1], iu[0])] = Phi[iu]
        return L, th, Phi
    def f(x):
        L, th, Phi = unpack(x)
        Sig = L @ Phi @ L.T + np.diag(th)
        sign, logdet = np.linalg.slogdet(Sig)
        if sign <= 0:
            return 1e10
        return logdet + np.trace(Sm @ np.linalg.inv(Sig)) - np.linalg.slogdet(Sm)[1] - p
    sd = np.sqrt(np.diag(Sm))
    x0 = np.concatenate([np.array([0.7 * sd[idx[i]] for c in names for i in blocks[c]]), np.log(0.5 * sd ** 2), np.full(nphi, 0.3)])
    res = optimize.minimize(f, x0, method="L-BFGS-B", options={"maxiter": 5000})
    L, th, Phi = unpack(res.x)
    Fmin = res.fun
    q = nl + nth + nphi
    df = p * (p + 1) // 2 - q
    chi2 = (n - 1) * Fmin
    F0 = np.linalg.slogdet(np.diag(np.diag(Sm)))[1] - np.linalg.slogdet(Sm)[1]
    chi0, df0 = (n - 1) * F0, p * (p - 1) // 2
    cfi = 1 - max(chi2 - df, 0) / max(chi0 - df0, chi2 - df, 1e-9)
    tli = ((chi0 / df0) - (chi2 / df)) / ((chi0 / df0) - 1) if df > 0 else None
    rmsea = math.sqrt(max(chi2 - df, 0) / (df * (n - 1))) if df > 0 else None
    Sig = L @ Phi @ L.T + np.diag(th)
    D = np.diag(1 / sd)
    res_c = D @ (Sm - Sig) @ D
    srmr = math.sqrt((res_c[np.tril_indices(p)] ** 2).mean())
    std_load = {c: [float(L[idx[i], ci] / sd[idx[i]]) for i in blocks[c]] for ci, c in enumerate(names)}
    return {"loadings": std_load, "phi": pd.DataFrame(Phi, index=names, columns=names),
            "fit": {"chi2": r3(chi2), "df": int(df), "chi2/df": r3(chi2 / df) if df > 0 else None, "CFI": r3(cfi), "TLI": r3(tli), "RMSEA": r3(rmsea), "SRMR": r3(srmr)},
            "converged": bool(res.success)}


# ---------------------------------------------------------------- comparison helpers
def num(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r"-?\d*\.?\d+", str(v).replace("−", "-"))
    return float(m.group(0)) if m else None

def pnum(row):
    p = num(row.get("p"))
    if p is not None and 0 <= p <= 1:
        return p
    t = str(row.get("p_text") or "").replace(" ", "")
    if t.startswith("<"):
        v = num(t)
        return v - 1e-6 if v is not None else None
    return None


@app.get("/health")
def health():
    return {"ok": True, "service": "q1-stats", "version": "1.0"}


@app.post("/analyze")
async def analyze(file: UploadFile = File(...), spec: str = Form("{}"), x_q1_token: str = Header(default="")):
    if TOKEN and x_q1_token != TOKEN:
        raise HTTPException(401, "bad token")
    raw = await file.read()
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(413, "dataset larger than 25 MB")
    try:
        sp = json.loads(spec or "{}")
    except Exception:
        raise HTTPException(400, "spec is not valid JSON")
    warnings = []
    try:
        df = load_table(raw, file.filename)
    except Exception as e:
        raise HTTPException(400, "could not read dataset: " + str(e)[:200])
    df.columns = [str(c).strip() for c in df.columns]
    out = {"dataset": {"file": file.filename, "rows": int(len(df)), "columns": int(df.shape[1]), "column_names": list(df.columns)[:200]}}
    blocks = map_constructs(df, sp, warnings)
    out["mapping"] = blocks
    if not blocks:
        out["warnings"] = warnings + ["No construct could be mapped to dataset columns, so nothing was reproduced."]
        out["comparisons"] = []
        return out
    used = sorted({c for v in blocks.values() for c in v})
    sub = df[used].apply(pd.to_numeric, errors="coerce")
    miss = sub.isna().mean()
    complete = sub.dropna()
    out["sample"] = {"rows": int(len(df)), "complete_cases": int(len(complete)), "max_missing_pct": r3(miss.max() * 100),
                     "items_missing_over_5pct": [c for c in used if miss[c] > 0.05]}
    if len(complete) < 30:
        out["warnings"] = warnings + ["Fewer than 30 complete cases; statistics not reproduced."]
        out["comparisons"] = []
        return out
    Z = (complete - complete.mean()) / complete.std(ddof=0)
    Z = Z.loc[:, Z.std() > 0]
    blocks = {k: [c for c in v if c in Z.columns] for k, v in blocks.items()}
    blocks = {k: v for k, v in blocks.items() if v}
    R = complete.corr()
    names = list(blocks)
    # paths
    paths = []
    for pth in sp.get("paths", []):
        a, b = match_construct(pth.get("from"), names), match_construct(pth.get("to"), names)
        if a and b and a != b and (a, b) not in [(x[0], x[1]) for x in paths]:
            paths.append((a, b, pth.get("hypothesis", "")))
        elif pth.get("from") or pth.get("to"):
            warnings.append("Path not reproduced (construct not mapped): " + str(pth.get("from")) + " -> " + str(pth.get("to")))
    method = str(sp.get("method") or "AUTO").upper()
    if method == "AUTO":
        method = "PLS"
    pp = [(a, b) for a, b, _ in paths]
    P = pls(Z, blocks, pp)
    meas_load = P["loadings"]
    cb = None
    if method == "CB" and sum(len(v) for v in blocks.values()) <= 80:
        try:
            cb = cfa(complete.cov(), len(complete), blocks)
            meas_load = cb["loadings"]
            out["fit"] = cb["fit"]
            if not cb["converged"]:
                warnings.append("CFA did not fully converge; loadings may be approximate.")
        except Exception as e:
            warnings.append("CFA failed (" + str(e)[:120] + "); PLS loadings used instead.")
    # measurement table
    rel = []
    for c in names:
        cr, ave = cr_ave(meas_load[c])
        rel.append({"construct": c, "items": len(blocks[c]), "alpha": r3(cronbach_alpha(complete[blocks[c]])), "cr": r3(cr), "ave": r3(ave),
                    "loadings": {i: r3(l) for i, l in zip(blocks[c], meas_load[c])}})
    out["reliability"] = rel
    ht = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            ht.append({"a": names[i], "b": names[j], "htmt": r3(htmt(R, blocks, names[i], names[j]))})
    out["htmt"] = ht
    lvcorr = pd.DataFrame({n: P["scores"][n] for n in names}).corr() if cb is None else cb["phi"]
    fl = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = names[i], names[j]
            ra = next(r for r in rel if r["construct"] == a); rb = next(r for r in rel if r["construct"] == b)
            c_ab = float(lvcorr.loc[a, b])
            ok = all(x["ave"] is not None and math.sqrt(x["ave"]) > abs(c_ab) for x in (ra, rb))
            fl.append({"a": a, "b": b, "corr": r3(c_ab), "passes": ok})
    out["fornell_larcker"] = fl
    # structural model (+ bootstrap)
    B = int(min(max(int(sp.get("bootstrap", 500)), 100), 2000))
    rng = np.random.default_rng(42)
    ind_specs = []
    for ind in sp.get("indirect", []):
        x, m, y = (match_construct(ind.get(k), names) for k in ("x", "m", "y"))
        if x and m and y and (x, m) in pp and (m, y) in pp:
            ind_specs.append((x, m, y, ind.get("hypothesis", "")))
    boot_b = {k: [] for k in P["beta"]}
    boot_i = {s: [] for s in ind_specs}
    if paths:
        for _ in range(B):
            ix = rng.integers(0, len(Z), len(Z))
            Zb = Z.iloc[ix].reset_index(drop=True)
            Zb = (Zb - Zb.mean()) / Zb.std(ddof=0).replace(0, 1)
            try:
                Pb = pls(Zb, blocks, pp, max_iter=100, tol=1e-5)
            except Exception:
                continue
            for k in boot_b:
                if k in Pb["beta"]:
                    boot_b[k].append(Pb["beta"][k])
            for s in ind_specs:
                boot_i[s].append(Pb["beta"].get((s[0], s[1]), np.nan) * Pb["beta"].get((s[1], s[2]), np.nan))
    def summ(est, arr_):
        a = np.array([v for v in arr_ if not np.isnan(v)])
        if len(a) < 20:
            return {"beta": r3(est)}
        se = a.std(ddof=1)
        t = est / se if se > 0 else None
        p = 2 * (1 - stats.norm.cdf(abs(t))) if t is not None else None
        lo, hi = np.percentile(a, [2.5, 97.5])
        return {"beta": r3(est), "se": r3(se), "t": r3(t), "p": r3(p), "ci_low": r3(lo), "ci_high": r3(hi), "significant": bool(lo > 0 or hi < 0)}
    out["paths"] = [dict(hypothesis=h, **{"from": a, "to": b}, **summ(P["beta"][(a, b)], boot_b.get((a, b), []))) for a, b, h in paths]
    out["indirect"] = [dict(hypothesis=s[3], x=s[0], m=s[1], y=s[2], **summ(P["beta"][(s[0], s[1])] * P["beta"][(s[1], s[2])], boot_i[s])) for s in ind_specs]
    out["r2"] = [{"construct": k, "r2": r3(v)} for k, v in P["r2"].items()]
    out["vif"] = [{"from": a, "to": b, "vif": r3(v)} for (a, b), v in P["vif"].items()]
    out["method"] = ("CB-SEM (ML CFA; structural paths estimated with PLS scores)" if cb else "PLS-SEM (path weighting, mode A)") + ", bootstrap " + str(B)
    # ---------------------------------------------------------------- reported vs reproduced
    rep = sp.get("reported") or {}
    comps = []
    def comp(what, reported, reproduced, tol, location="", kind="value"):
        if reported is None or reproduced is None:
            return
        ok = abs(reported - reproduced) <= tol
        comps.append({"what": what, "reported": reported, "reproduced": reproduced, "consistent": ok, "tolerance": tol, "location": location, "kind": kind})
    rn = num(sp.get("reported_n"))
    if rn:
        closest = min([float(len(df)), float(len(complete))], key=lambda v: abs(v - rn))
        comp("Sample size (rows / complete cases in dataset: " + str(len(df)) + " / " + str(len(complete)) + ")", rn, closest, 0.5, kind="n")
    for r in rep.get("reliability", []):
        c = match_construct(r.get("construct"), names)
        if not c:
            continue
        mine = next(x for x in rel if x["construct"] == c)
        comp("Cronbach alpha - " + c, num(r.get("alpha")), mine["alpha"], 0.03, r.get("location", ""))
        comp("Composite reliability - " + c, num(r.get("cr")), mine["cr"], 0.03, r.get("location", ""))
        comp("AVE - " + c, num(r.get("ave")), mine["ave"], 0.03, r.get("location", ""))
    for l in rep.get("loadings", []):
        c = match_construct(l.get("construct"), names)
        if not c:
            continue
        col = next((i for i in blocks[c] if norm(i).replace(" ", "") == norm(l.get("item")).replace(" ", "")), None)
        if col:
            mine = next(x for x in rel if x["construct"] == c)["loadings"].get(col)
            comp("Loading " + str(l.get("item")), num(l.get("loading")), mine, 0.05, l.get("location", ""))
    for h in rep.get("htmt", []):
        a, b = match_construct(h.get("a"), names), match_construct(h.get("b"), names)
        mine = next((x["htmt"] for x in ht if {x["a"], x["b"]} == {a, b}), None) if a and b else None
        comp("HTMT " + str(h.get("a")) + " - " + str(h.get("b")), num(h.get("value")), mine, 0.05, h.get("location", ""))
    def path_label(r):
        return ((r.get("hypothesis") or "") + " " + (r.get("path") or "")).strip()
    for r in rep.get("paths", []):
        parts = re.split(r"\s*(?:->|→|=>|–>|to)\s*", str(r.get("path") or ""))
        a = match_construct(parts[0], names) if len(parts) >= 2 else None
        b = match_construct(parts[-1], names) if len(parts) >= 2 else None
        mine = next((x for x in out["paths"] if x["from"] == a and x["to"] == b), None)
        if mine:
            comp("Path " + path_label(r), num(r.get("beta")), mine["beta"], 0.05, r.get("location", ""))
            p_rep = pnum(r)
            if p_rep is not None and mine.get("p") is not None and (p_rep < 0.05) != (mine["p"] < 0.05):
                comps.append({"what": "Significance of " + path_label(r), "reported": r.get("p_text") or r.get("p"), "reproduced": mine["p"], "consistent": False, "location": r.get("location", ""), "kind": "significance"})
    for r in rep.get("indirect", []):
        parts = re.split(r"\s*(?:->|→|=>|–>)\s*", str(r.get("path") or ""))
        if len(parts) >= 3:
            x, m, y = (match_construct(p_, names) for p_ in (parts[0], parts[1], parts[-1]))
            mine = next((q for q in out["indirect"] if (q["x"], q["m"], q["y"]) == (x, m, y)), None)
            if mine:
                comp("Indirect effect " + path_label(r), num(r.get("beta")), mine["beta"], 0.03, r.get("location", ""))
                if mine.get("ci_low") is not None:
                    rs = str(r.get("reported_support") or "").lower()
                    claimed = rs.startswith("support") or "significant" in rs
                    if claimed and not mine["significant"]:
                        comps.append({"what": "Mediation " + path_label(r), "reported": "supported", "reproduced": "bootstrap 95% CI [" + str(mine["ci_low"]) + ", " + str(mine["ci_high"]) + "] includes zero", "consistent": False, "location": r.get("location", ""), "kind": "significance"})
    out["comparisons"] = comps
    out["warnings"] = warnings
    return out
