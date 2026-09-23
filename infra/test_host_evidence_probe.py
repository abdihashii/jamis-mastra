import subprocess
import unittest
from unittest.mock import patch

from infra import host_evidence_probe as probe


class HostEvidenceProbeTest(unittest.TestCase):
    def test_fixed_docker_selection_discards_raw_names_and_metadata(self):
        raw = (
            "app\trunning\npostgres\texited\n"
            "secret-service +15551234567\trunning\n"
            "clickhouse\tapi_key=secret\n"
        )
        states = probe._docker_states(raw)
        self.assertEqual(states, [
            {"component": "app", "state": "running"},
            {"component": "postgres", "state": "exited"},
            {"component": "clickhouse", "state": "unknown"},
            {"component": "cloudflared", "state": "missing"},
        ])
        self.assertNotIn("secret", str(states))
        self.assertNotIn("+15551234567", str(states))

    def test_docker_failure_does_not_erase_host(self):
        proc = {
            "/proc/meminfo": "MemTotal: 2000000 kB\nMemAvailable: 1048576 kB\n",
            "/proc/loadavg": "0.75 0.5 0.3 1/200 123\n",
            "/proc/uptime": "12345.6 10000.0\n",
        }
        failed = subprocess.CompletedProcess(probe.DOCKER_COMMAND, 1, "secret +15551234567")
        with patch.object(probe, "_read", side_effect=lambda path, _: proc[path]), \
                patch.object(probe.subprocess, "run", return_value=failed):
            evidence = probe.probe()
        self.assertEqual(evidence["host"]["availability"], "available")
        self.assertEqual(evidence["host"]["memoryAvailableMiB"], 1024)
        self.assertEqual(evidence["docker"]["availability"], "unavailable")
        self.assertNotIn("secret", str(evidence))
        self.assertNotIn("+15551234567", str(evidence))
        self.assertTrue(evidence["host"]["observedAt"].endswith("Z"))


if __name__ == "__main__":
    unittest.main()
