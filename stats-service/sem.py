"""PLS-SEM (path weighting) and CFA (maximum likelihood, CB-SEM), shared by the review and the Writing data analysis.

Moved unchanged from app.py. r3 rounds to three decimals.
"""
import math
import numpy as np
import pandas as pd
from scipy import optimize


def r3(x):
    return None if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))) else round(float(x), 3)


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


