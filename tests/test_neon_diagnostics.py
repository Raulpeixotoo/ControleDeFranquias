import unittest

from migrar_para_neon import connection_hint, normalize_url


class NeonDiagnostics(unittest.TestCase):
    def test_accepts_neon_psql_snippet_without_changing_credentials(self):
        uri = "postgresql://test:fake%40secret@example.invalid/test?sslmode=require"
        self.assertEqual(normalize_url("psql '" + uri + "'"), uri)
        self.assertEqual(normalize_url('"' + uri + '"'), uri)
        with self.assertRaises(ValueError):
            normalize_url("psql --help")

    def test_diagnostics_distinguish_errors_and_redact_details(self):
        cases = [("password authentication failed", "autenticação"),
                 ("failed to resolve host", "DNS"),
                 ("connection timeout expired", "não respondeu"),
                 ("SSL certificate verify failed", "conexão segura"),
                 ("connection refused", "recusada")]
        for message, expected in cases:
            hint = connection_hint(RuntimeError(message + " password=FAKE_SECRET host=PRIVATE_HOST"))
            self.assertIn(expected, hint)
            self.assertNotIn("FAKE_SECRET", hint)
            self.assertNotIn("PRIVATE_HOST", hint)
