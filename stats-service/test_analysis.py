import unittest
import numpy as np
import pandas as pd
from scipy import stats
import analysis as A


def sample():
    rng = np.random.default_rng(7)
    n = 120
    x1 = rng.normal(size=n)
    x2 = rng.normal(size=n)
    y = 0.5 * x1 + 0.3 * x2 + rng.normal(scale=0.8, size=n)
    items = {f'q{i}': x1 + rng.normal(scale=0.7, size=n) for i in range(1, 5)}
    df = pd.DataFrame({'x1': x1, 'x2': x2, 'y': y, **items})
    return df


def latent_sample(n=300, seed=11):
    rng = np.random.default_rng(seed)
    eta1 = rng.normal(size=n)
    eta2 = 0.5 * eta1 + rng.normal(scale=np.sqrt(1 - 0.25), size=n)
    cols = {}
    for i in range(1, 4):
        cols[f'a{i}'] = 0.8 * eta1 + rng.normal(scale=0.6, size=n)
        cols[f'b{i}'] = 0.8 * eta2 + rng.normal(scale=0.6, size=n)
    return pd.DataFrame(cols)


class Sem(unittest.TestCase):
    spec = {'constructs': [{'name': 'A', 'items': ['a1', 'a2', 'a3']}, {'name': 'B', 'items': ['b1', 'b2', 'b3']}],
            'paths': [{'from': 'A', 'to': 'B'}], 'bootstrap': 150}

    def test_pls_recovers_loadings_and_path(self):
        out = A.sem_models(latent_sample(), dict(self.spec, method='PLS'))
        self.assertTrue(all(l > 0.6 for ls in out['loadings'].values() for l in ls))
        path = out['paths'][0]
        self.assertAlmostEqual(path['beta'], 0.5, delta=0.15)
        self.assertLess(path['p'], 0.05)
        self.assertGreater(out['r2']['B'], 0.1)

    def test_cfa_fits_the_true_model(self):
        out = A.sem_models(latent_sample(), dict(self.spec, method='CB', bootstrap=0))
        self.assertTrue(out['converged'])
        self.assertGreater(out['fit']['CFI'], 0.9)
        self.assertLess(out['fit']['RMSEA'], 0.08)

    def test_needs_constructs_and_enough_rows(self):
        with self.assertRaises(ValueError):
            A.sem_models(latent_sample(), {'constructs': []})
        with self.assertRaises(ValueError):
            A.sem_models(latent_sample(n=20), dict(self.spec, bootstrap=0))

    def test_run_analyses_includes_sem_sentences(self):
        out = A.run_analyses(latent_sample(), dict(self.spec, method='PLS'))
        self.assertIn('sem', out)
        self.assertTrue(any('β =' in s for s in out['sentences']))


class Analysis(unittest.TestCase):
    def test_describe_matches_numpy(self):
        df = sample()
        r = A.describe(df, ['y'])[0]
        self.assertAlmostEqual(r['mean'], df['y'].mean())
        self.assertAlmostEqual(r['sd'], df['y'].std(ddof=1))
        self.assertEqual(r['n'], len(df))

    def test_regression_matches_numpy_least_squares(self):
        df = sample()
        res = A.ols(df, 'y', ['x1', 'x2'])
        X = np.column_stack([np.ones(len(df)), df[['x1', 'x2']].to_numpy()])
        beta, *_ = np.linalg.lstsq(X, df['y'].to_numpy(), rcond=None)
        self.assertAlmostEqual(res['coefficients'][1]['b'], beta[1], places=8)
        resid = df['y'].to_numpy() - X @ beta
        r2 = 1 - resid @ resid / ((df['y'] - df['y'].mean()) ** 2).sum()
        self.assertAlmostEqual(res['r2'], r2, places=10)
        self.assertGreater(res['coefficients'][1]['t'], 0)
        self.assertLess(res['coefficients'][1]['p'], 0.05)
        self.assertEqual(res['df2'], len(df) - 3)

    def test_standardised_beta_is_scale_free(self):
        df = sample()
        res = A.ols(df, 'y', ['x1'])
        scaled = df.assign(x1=df['x1'] * 1000)
        res2 = A.ols(scaled, 'y', ['x1'])
        self.assertAlmostEqual(res['coefficients'][1]['beta'], res2['coefficients'][1]['beta'], places=8)

    def test_alpha_matches_formula(self):
        df = sample()
        a = A.cronbach(df, ['q1', 'q2', 'q3', 'q4'])
        X = df[['q1', 'q2', 'q3', 'q4']]
        k = 4
        expected = k / (k - 1) * (1 - X.var(ddof=1).sum() / X.sum(axis=1).var(ddof=1))
        self.assertAlmostEqual(a['alpha'], expected)
        self.assertGreater(a['alpha'], 0.6)

    def test_correlation_matches_scipy(self):
        df = sample()
        c = A.correlations(df, ['x1', 'y'])[0]
        r, p = stats.pearsonr(df['x1'], df['y'])
        self.assertAlmostEqual(c['r'], r)
        self.assertAlmostEqual(c['p'], p)

    def test_run_analyses_writes_apa_sentences(self):
        df = sample()
        out = A.run_analyses(df, {'describe': ['y'], 'reliability': [{'name': 'Quality', 'items': ['q1', 'q2', 'q3', 'q4']}],
                                  'correlations': ['x1', 'y'], 'regression': {'y': 'y', 'x': ['x1', 'x2']}})
        text = ' '.join(out['sentences'])
        self.assertIn('Cronbach', text)
        self.assertIn('R² =', text)
        self.assertIn('F(2, 117)', text)
        self.assertTrue(any('M = ' in s for s in out['sentences']))

    def test_missing_column_and_too_few_rows(self):
        df = sample()
        with self.assertRaises(ValueError):
            A.describe(df, ['nope'])
        with self.assertRaises(ValueError):
            A.ols(df.head(3), 'y', ['x1', 'x2'])


if __name__ == '__main__':
    unittest.main()
