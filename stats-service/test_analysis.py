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
