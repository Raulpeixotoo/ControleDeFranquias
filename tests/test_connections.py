import os
import unittest
from unittest.mock import patch

import database
from psycopg import OperationalError


class ConnectionFailures(unittest.TestCase):
    def test_repeated_failed_connections_do_not_poison_waiting_queue(self):
        url = "postgresql://test:fake@db-test.invalid/test"
        with patch.dict(os.environ, {"DATABASE_URL": url}), patch("psycopg.Connection.connect", side_effect=OperationalError("simulated network failure")):
            try:
                for _ in range(20):
                    with self.assertRaises(OperationalError):
                        database.connect("unused.db")
                stats = database._pools[url].get_stats()
                self.assertEqual(stats["requests_waiting"], 0)
                self.assertEqual(stats["pool_size"], 0)
            finally:
                pool = database._pools.pop(url, None)
                if pool:
                    pool.close()

    def test_public_diagnostics_do_not_include_connection_secrets(self):
        error = OperationalError("password authentication failed for user PRIVATE_USER password=PRIVATE_SECRET")
        code, message, retryable = database.failure_details(error)
        self.assertEqual(code, "DB_AUTH")
        self.assertFalse(retryable)
        self.assertNotIn("PRIVATE_USER", message)
        self.assertNotIn("PRIVATE_SECRET", message)
