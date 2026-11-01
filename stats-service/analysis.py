"""Descriptive, reliability, correlation and regression analyses for the Writing page.

Pure functions on a pandas DataFrame, so they can be tested without the web server.
run_analyses() returns the numbers and APA-style sentences for the Results section.
No data is stored.
"""
import io
import math
import numpy as np
import pandas as pd
from scipy import stats

from sem import pls, cfa

MAX_ROWS = 200000


def load_frame(raw: bytes, filename: str) -> pd.DataFrame:
    name = (filename or '').lower()
    if name.endswith('.csv') or name.endswith('.txt'):
        return pd.read_csv(io.BytesIO(raw))
    if name.endswith('.xlsx') or name.endswith('.xls'):
        return pd.read_excel(io.BytesIO(raw))
    if name.endswith('.sav'):
        import pyreadstat
        df, _ = pyreadstat.read_sav(io.BytesIO(raw))
        return df
    raise ValueError('Upload a CSV, XLSX or SAV file')


def _num(df, cols):
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise ValueError('Columns not found in the dataset: ' + ', '.join(missing))
    out = df[cols].apply(pd.to_numeric, errors='coerce')
    return out


def p_text(p):
    return 'p < .001' if p < 0.001 else 'p = ' + ('%.3f' % p).lstrip('0')


def num_text(x, d=2):
    return ('%.*f' % (d, x)).replace('0.', '.', 1) if abs(x) < 1 and x != 0 else '%.*f' % (d, x)


def describe(df, cols):
    d = _num(df, cols)
    rows = []
    for c in cols:
        s = d[c].dropna()
        rows.append({'variable': c, 'n': int(s.size), 'mean': float(s.mean()), 'sd': float(s.std(ddof=1)),
                     'min': float(s.min()), 'max': float(s.max()),
                     'skew': float(stats.skew(s, bias=False)) if s.size > 2 else None,
                     'kurtosis': float(stats.kurtosis(s, bias=False)) if s.size > 3 else None})
    return rows


def cronbach(df, items):
    d = _num(df, items).dropna()
    k = len(items)
    if d.shape[0] < 3 or k < 2:
        return {'alpha': None, 'k': k, 'n': int(d.shape[0])}
    var = d.var(ddof=1)
    total = d.sum(axis=1).var(ddof=1)
    alpha = (k / (k - 1)) * (1 - var.sum() / total) if total > 0 else None
    return {'alpha': float(alpha) if alpha is not None else None, 'k': k, 'n': int(d.shape[0])}


def correlations(df, cols):
    d = _num(df, cols).dropna()
    out = []
    for i, a in enumerate(cols):
        for b in cols[i + 1:]:
            r, p = stats.pearsonr(d[a], d[b])
            out.append({'a': a, 'b': b, 'r': float(r), 'p': float(p), 'n': int(d.shape[0])})
    return out


def ols(df, y, xs):
    """Ordinary least squares with standardised betas. Rows with any missing value are dropped."""
    d = _num(df, [y] + xs).dropna()
    n, k = d.shape[0], len(xs)
    if n <= k + 2:
        raise ValueError('Too few complete rows for this regression (%d)' % n)
    Y = d[y].to_numpy(float)
    X = np.column_stack([np.ones(n), d[xs].to_numpy(float)])
    beta, *_ = np.linalg.lstsq(X, Y, rcond=None)
    resid = Y - X @ beta
    df_res = n - k - 1
    sse = float(resid @ resid)
    sst = float(((Y - Y.mean()) ** 2).sum())
    sigma2 = sse / df_res
    cov = sigma2 * np.linalg.pinv(X.T @ X)
    se = np.sqrt(np.diag(cov))
    t = beta / se
    p = 2 * stats.t.sf(np.abs(t), df_res)
    r2 = 1 - sse / sst if sst > 0 else float('nan')
    adj = 1 - (1 - r2) * (n - 1) / df_res
    F = ((sst - sse) / k) / sigma2 if k else float('nan')
    pF = float(stats.f.sf(F, k, df_res)) if k else float('nan')
    sy = d[y].std(ddof=1)
    sx = d[xs].std(ddof=1).to_numpy(float)
    std_beta = [float(beta[i + 1] * sx[i] / sy) for i in range(k)]
    coefs = []
    for i, name in enumerate(['(Intercept)'] + xs):
        coefs.append({'term': name, 'b': float(beta[i]), 'se': float(se[i]), 't': float(t[i]), 'p': float(p[i]),
                      'beta': None if i == 0 else std_beta[i - 1]})
    return {'n': n, 'coefficients': coefs, 'r2': r2, 'adj_r2': adj, 'F': float(F), 'df1': k, 'df2': df_res, 'p_F': pF}


def _apa_regression(res, y, xs):
    parts = ['A regression of %s on %s (n = %d) explained %s of the variance, R² = %s, adjusted R² = %s, F(%d, %d) = %.2f, %s.'
             % (y, ', '.join(xs), res['n'], '%.0f%%' % (100 * res['r2']), num_text(res['r2']), num_text(res['adj_r2']),
                res['df1'], res['df2'], res['F'], p_text(res['p_F']))]
    for c in res['coefficients'][1:]:
        parts.append('%s: b = %s, SE = %s, β = %s, t(%d) = %.2f, %s.'
                     % (c['term'], num_text(c['b']), num_text(c['se']), num_text(c['beta']), res['df2'], c['t'], p_text(c['p'])))
    return ' '.join(parts)


def sem_models(df, spec, rng_seed=2026):
    """PLS-SEM path model (method PLS) or CFA fit for the measurement model (method CB).
    spec: {'method': 'PLS'|'CB', 'constructs': [{'name', 'items'}], 'paths': [{'from', 'to'}], 'bootstrap': 200}
    """
    constructs = spec.get('constructs') or []
    if not constructs:
        raise ValueError('Name the constructs and their items first')
    blocks = {c['name']: list(c['items']) for c in constructs}
    used = sorted({i for v in blocks.values() for i in v})
    complete = _num(df, used).dropna()
    if len(complete) < 30:
        raise ValueError('Fewer than 30 complete cases (%d); SEM not run' % len(complete))
    Z = (complete - complete.mean()) / complete.std(ddof=0)
    Z = Z.loc[:, Z.std() > 0]
    blocks = {k: [i for i in v if i in Z.columns] for k, v in blocks.items()}
    blocks = {k: v for k, v in blocks.items() if v}
    names = list(blocks)
    paths = []
    for pth in spec.get('paths') or []:
        a, b = pth.get('from'), pth.get('to')
        if a in names and b in names and a != b:
            paths.append((a, b))
    method = str(spec.get('method') or 'PLS').upper()
    out = {'n': int(len(complete)), 'method': method, 'constructs': names, 'loadings': {}, 'paths': [], 'r2': {},
           'fit': None, 'sentences': []}
    P = pls(Z, blocks, paths)
    loadings = P['loadings']
    out['r2'] = P['r2']
    for (a, b), beta in P['beta'].items():
        out['paths'].append({'from': a, 'to': b, 'beta': beta})
    if method == 'CB':
        cb = cfa(complete.cov(), len(complete), blocks)
        loadings = cb['loadings']
        out['fit'] = cb['fit']
        out['converged'] = cb['converged']
        out['sentences'].append('Measurement model (CFA): ' + ', '.join('%s = %s' % (k, v) for k, v in cb['fit'].items() if v is not None) + '.')
    out['loadings'] = {c: [float(x) for x in loadings[c]] for c in names}
    # Bootstrap: resample complete cases to get standard errors and significance for each path.
    boot_n = min(1000, max(0, int(spec.get('bootstrap') or 200)))
    if paths and boot_n:
        rng = np.random.default_rng(rng_seed)
        draws = {pth: [] for pth in paths}
        for _ in range(boot_n):
            idx = rng.integers(0, len(Z), len(Z))
            Zb = Z.iloc[idx].reset_index(drop=True)
            Pb = pls(Zb, blocks, paths, max_iter=100, tol=1e-5)
            for pth in paths:
                if pth in Pb['beta']:
                    draws[pth].append(Pb['beta'][pth])
        for row in out['paths']:
            d = np.array(draws[(row['from'], row['to'])])
            se = float(d.std(ddof=1)) if d.size > 1 else float('nan')
            t = row['beta'] / se if se and not math.isnan(se) and se > 0 else float('nan')
            row['se'] = se
            row['t'] = t
            row['p'] = float(2 * stats.norm.sf(abs(t))) if not math.isnan(t) else float('nan')
            out['sentences'].append('%s → %s: β = %s, SE = %s, t = %.2f, %s.' % (row['from'], row['to'], num_text(row['beta']),
                                    num_text(se), t, p_text(row['p'])))
        out['bootstrap'] = boot_n
    for n_, r2 in P['r2'].items():
        out['sentences'].append('R² for %s = %s.' % (n_, num_text(r2)))
    return out


def run_analyses(df, spec):
    """spec: {'describe': [cols], 'reliability': [{'name': 'Service', 'items': [...]}],
              'correlations': [cols], 'regression': {'y': col, 'x': [cols]}}"""
    if df.shape[0] > MAX_ROWS:
        raise ValueError('Dataset too large (more than %d rows)' % MAX_ROWS)
    out = {'descriptives': [], 'reliability': [], 'correlations': [], 'regression': None, 'sentences': []}
    desc_cols = spec.get('describe') or []
    if desc_cols:
        out['descriptives'] = describe(df, desc_cols)
        for r in out['descriptives']:
            out['sentences'].append('%s: M = %s, SD = %s (n = %d).' % (r['variable'], num_text(r['mean']), num_text(r['sd']), r['n']))
    for rel in spec.get('reliability') or []:
        res = cronbach(df, rel['items'])
        res['name'] = rel.get('name') or 'Scale'
        out['reliability'].append(res)
        if res['alpha'] is not None:
            out['sentences'].append("%s: Cronbach's α = %s (%d items, n = %d)." % (res['name'], num_text(res['alpha']), res['k'], res['n']))
    cor_cols = spec.get('correlations') or []
    if len(cor_cols) >= 2:
        out['correlations'] = correlations(df, cor_cols)
        for c in out['correlations']:
            out['sentences'].append('%s and %s: r(%d) = %s, %s.' % (c['a'], c['b'], c['n'] - 2, num_text(c['r']), p_text(c['p'])))
    reg = spec.get('regression')
    if reg and reg.get('y') and reg.get('x'):
        res = ols(df, reg['y'], reg['x'])
        out['regression'] = res
        out['sentences'].append(_apa_regression(res, reg['y'], reg['x']))
    if spec.get('constructs'):
        out['sem'] = sem_models(df, spec)
        out['sentences'].extend(out['sem']['sentences'])
    return out
