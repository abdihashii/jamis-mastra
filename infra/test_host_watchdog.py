import contextlib
import fcntl
import tempfile
from pathlib import Path
import http.client
import io
import json
import signal
import socket
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

from infra import host_watchdog as watchdog

CONFIG = dict(zip(watchdog.CREDENTIALS, ("secret-key", "secret-token",
                                        "+15555550100", "+15555550101")))
ACCEPTED = {"message_handle": "handle", "status": "QUEUED"}


class HostWatchdogTest(unittest.TestCase):
    def test_classification(self):
        cases = [
            (200, {**ACCEPTED, "status": status}, "accepted")
            for status in ("QUEUED", "SENT", "DELIVERED")
        ] + [
            (200, {"status": "ERROR", "error_message": "secret"}, "rejected"),
            (400, {}, "rejected"), (429, {}, "rejected"),
            (500, ACCEPTED, "unknown"), (302, ACCEPTED, "unknown"),
            (200, {}, "unknown"), (200, [], "unknown"),
            (200, {**ACCEPTED, "message_handle": " "}, "unknown"),
            (200, {**ACCEPTED, "error_code": 123}, "unknown"),
            (200, {**ACCEPTED, "error_code": False}, "unknown"),
            (200, {**ACCEPTED, "error_message": "secret"}, "unknown"),
            (200, {**ACCEPTED, "error_code": 0}, "accepted"),
        ]
        for status, data, expected in cases:
            with self.subTest(status=status, data=data):
                self.assertEqual(watchdog.classify_response(status, json.dumps(data).encode()), expected)
        for body in (b"bad json", b"\xff", b"[" * 2000, b" " * watchdog.MAX_RESPONSE + b"{}"):
            self.assertEqual(watchdog.classify_response(200, body), "unknown")

    def test_single_post_bounded_read_and_cleanup(self):
        for status, body, expected in (
            (200, json.dumps(ACCEPTED).encode(), "accepted"),
            (200, b'{"status":"ERROR"}', "rejected"),
            (403, b"secret", "rejected"), (503, b"secret", "unknown"),
            (307, b"secret", "unknown"), (200, b"broken", "unknown"),
            (200, b"x" * (watchdog.MAX_RESPONSE + 1), "unknown"),
        ):
            with self.subTest(status=status, expected=expected):
                connection = MagicMock()
                response = connection.getresponse.return_value
                response.status = status
                response.read.return_value = body
                with patch.object(watchdog.http.client, "HTTPSConnection", return_value=connection) as factory:
                    self.assertEqual(watchdog.send_notification(CONFIG, "test"), expected)
                factory.assert_called_once_with("api.sendblue.co", timeout=15)
                connection.request.assert_called_once()
                args, kwargs = connection.request.call_args
                self.assertEqual(args, ("POST", "/api/send-message"))
                self.assertEqual(json.loads(kwargs["body"]), {
                    "number": CONFIG["JAMIS_ALLOWED_NUMBER"],
                    "from_number": CONFIG["SENDBLUE_FROM_NUMBER"], "content": "test",
                })
                self.assertEqual(kwargs["headers"]["sb-api-key-id"], CONFIG["SENDBLUE_API_KEY"])
                self.assertEqual(kwargs["headers"]["sb-api-secret-key"], CONFIG["SENDBLUE_API_SECRET"])
                if status == 200:
                    response.read.assert_called_once_with(watchdog.MAX_RESPONSE + 1)
                connection.close.assert_called_once()
                self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0, 0))

    def test_transport_errors_are_unknown_without_retry_or_secret_output(self):
        for error in (TimeoutError("secret"), OSError("secret"),
                      http.client.RemoteDisconnected("secret")):
            connection = MagicMock()
            connection.getresponse.side_effect = error
            output = io.StringIO()
            with patch.dict(watchdog.os.environ, CONFIG, clear=True), \
                    patch.object(watchdog.http.client, "HTTPSConnection", return_value=connection), \
                    contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                self.assertEqual(watchdog.main(["--test-notification"]), 1)
            self.assertEqual(output.getvalue(), "watchdog: test notification unknown\n")
            connection.request.assert_called_once()
            connection.close.assert_called_once()

    def test_cli_requires_explicit_mode_and_valid_configuration(self):
        with patch.object(watchdog, "send_notification") as send:
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                watchdog.main([])
            for values in ({}, {**CONFIG, "SENDBLUE_API_KEY": "secret\nheader"},
                           {**CONFIG, "JAMIS_ALLOWED_NUMBER": "secret"}):
                output = io.StringIO()
                with patch.dict(watchdog.os.environ, values, clear=True), contextlib.redirect_stderr(output):
                    self.assertEqual(watchdog.main(["--test-notification"]), 2)
                self.assertEqual(output.getvalue(), "watchdog: invalid notification configuration\n")
            send.assert_not_called()

    def test_cli_test_label_utc_and_sanitized_acceptance(self):
        output = io.StringIO()
        with patch.dict(watchdog.os.environ, CONFIG, clear=True), \
                patch.object(watchdog, "send_notification", return_value="accepted") as send, \
                contextlib.redirect_stdout(output):
            self.assertEqual(watchdog.main(["--test-notification"]), 0)
        message = send.call_args.args[1]
        self.assertTrue(message.startswith("JAMIS WATCHDOG TEST:"))
        self.assertRegex(message, r"Observed UTC: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertEqual(output.getvalue(), "watchdog: test notification accepted\n")

    def test_total_deadline_covers_stalled_headers_and_trickling_body(self):
        for trickle in (False, True):
            with self.subTest(trickle=trickle), socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen(1)
                listener.settimeout(2)
                stopped = threading.Event()
                posts = []

                def serve():
                    with listener.accept()[0] as client:
                        client.settimeout(2)
                        request = b""
                        while b"\r\n\r\n" not in request:
                            request += client.recv(4096)
                        posts.append(request)
                        if trickle:
                            client.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n")
                            while not stopped.wait(0.02):
                                try:
                                    client.sendall(b" ")
                                except OSError:
                                    break
                        else:
                            stopped.wait(2)

                thread = threading.Thread(target=serve, daemon=True)
                thread.start()
                previous = signal.getsignal(signal.SIGALRM)
                started = time.monotonic()
                try:
                    connection = http.client.HTTPConnection(*listener.getsockname(), timeout=2)
                    with patch.object(watchdog, "SEND_TIMEOUT", 0.15), \
                            patch.object(watchdog.http.client, "HTTPSConnection", return_value=connection):
                        self.assertEqual(watchdog.send_notification(CONFIG, "test"), "unknown")
                    self.assertLess(time.monotonic() - started, 1)
                    self.assertEqual(signal.getsignal(signal.SIGALRM), previous)
                    self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0, 0))
                finally:
                    stopped.set()
                    thread.join(3)
                self.assertFalse(thread.is_alive())
                self.assertEqual(len(posts), 1)


class PersistentWatchdogTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.now = 1700000000
        self.config = {**CONFIG, "API_TOKEN": "fake-token"}
        self.send = MagicMock(return_value="accepted")

    def run_check(self, disk=(0.50, 1000), ready=True, advance=60):
        self.now += advance
        with patch.object(watchdog, "disk_usage", return_value=disk), \
                patch.object(watchdog, "readiness", return_value=ready), \
                patch.object(watchdog.time, "time", return_value=self.now), \
                patch.object(watchdog, "send_notification", self.send):
            return watchdog.run_checks(self.config, self.directory)

    def state(self):
        return watchdog.load_state(self.directory)

    def test_disk_df_semantics_and_unavailable(self):
        fs = MagicMock(f_blocks=120, f_bfree=35, f_bavail=15, f_frsize=4096)
        with patch.object(watchdog.os, "statvfs", return_value=fs):
            self.assertEqual(watchdog.disk_usage(), (0.85, 15 * 4096))
        with patch.object(watchdog.os, "statvfs", side_effect=OSError("private")):
            self.assertIsNone(watchdog.disk_usage())

    def test_disk_exact_boundaries_silence_and_unavailable(self):
        for usage in (0.50, 0.849999):
            self.run_check((usage, 1000))
        self.send.assert_not_called()
        self.run_check((0.85, 1000))
        self.assertEqual(self.send.call_count, 1)
        for disk in ((0.99, 10), (0.80, 1000), None):
            self.run_check(disk)
        self.assertEqual(self.send.call_count, 1)
        self.assertTrue(self.state()["checks"]["disk"]["active"])
        self.run_check((0.799999, 1000))
        self.assertEqual(self.send.call_count, 2)
        self.assertIn("disk recovery", self.send.call_args.args[1])
        self.run_check()
        self.assertEqual(self.send.call_count, 2)

    def test_streaks_flapping_combined_transitions_and_restart(self):
        for ready in (False, False, True, False, False):
            self.run_check(ready=ready)
        self.send.assert_not_called()
        self.run_check((0.9, 100), False)
        self.assertEqual(self.send.call_count, 1)
        message = self.send.call_args.args[1]
        self.assertIn("disk alert", message)
        self.assertIn("readiness alert", message)
        self.run_check((0.9, 100), True)
        self.run_check((0.9, 100), False)
        self.run_check((0.9, 100), True)
        self.assertEqual(self.send.call_count, 1)
        self.run_check()
        self.assertEqual(self.send.call_count, 2)
        self.assertIn("disk recovery", self.send.call_args.args[1])
        self.assertIn("readiness recovery", self.send.call_args.args[1])
        self.assertEqual((self.directory / "state.json").stat().st_mode & 0o777, 0o600)

    def test_rejected_and_unknown_retry_deadlines(self):
        for outcome, delay in (("rejected", 300), ("unknown", 1800)):
            with self.subTest(outcome=outcome):
                watchdog.save_state(self.directory, watchdog.initial_state())
                self.send.reset_mock()
                self.send.return_value = outcome
                self.run_check((0.9, 100))
                self.run_check((0.9, 100), advance=delay - 1)
                self.assertEqual(self.send.call_count, 1)
                self.run_check((0.9, 100), advance=1)
                self.assertEqual(self.send.call_count, 2)
                self.assertEqual("possible repeat" in self.send.call_args.args[1], outcome == "unknown")

    def test_recovery_cancels_rejected_alert_and_bypasses_unknown_cooldown(self):
        self.send.return_value = "rejected"
        self.run_check((0.9, 100))
        self.run_check()
        self.assertEqual(self.send.call_count, 1)
        self.assertIsNone(self.state()["checks"]["disk"]["notice"])
        self.send.return_value = "unknown"
        self.run_check((0.9, 100))
        self.run_check()
        self.assertEqual(self.send.call_count, 3)
        self.assertIn("disk recovery", self.send.call_args.args[1])
        self.run_check((0.9, 100))
        self.assertEqual(self.send.call_count, 4)
        self.assertIn("disk alert", self.send.call_args.args[1])
        self.assertNotIn("possible repeat", self.send.call_args.args[1])

    def test_unknown_then_rejected_still_requires_recovery(self):
        self.send.return_value = "unknown"
        self.run_check((0.9, 100))
        self.send.return_value = "rejected"
        self.run_check((0.9, 100), advance=1800)
        self.run_check((0.9, 100), advance=300)
        self.assertIn("possible repeat", self.send.call_args.args[1])
        self.run_check()
        self.assertEqual(self.send.call_count, 4)
        self.assertIn("disk recovery", self.send.call_args.args[1])

    def test_recovery_outcomes_retry_and_accepted_silence(self):
        for outcome, delay in (("rejected", 300), ("unknown", 1800), ("accepted", 1800)):
            with self.subTest(outcome=outcome):
                watchdog.save_state(self.directory, watchdog.initial_state())
                self.send.reset_mock()
                self.send.return_value = "accepted"
                self.run_check((0.9, 100))
                self.send.return_value = outcome
                self.run_check()
                self.run_check(advance=delay - 1)
                self.assertEqual(self.send.call_count, 2)
                self.run_check(advance=1)
                self.assertEqual(self.send.call_count, 2 if outcome == "accepted" else 3)

    def test_interrupted_send_retains_durable_unknown_intent(self):
        def interrupt(config, message):
            self.assertEqual(self.state()["checks"]["disk"]["notice"]["outcome"], "unknown")
            raise KeyboardInterrupt()
        self.send.side_effect = interrupt
        with self.assertRaises(KeyboardInterrupt):
            self.run_check((0.9, 100))
        self.send.side_effect = None
        self.run_check((0.9, 100), advance=1799)
        self.assertEqual(self.send.call_count, 1)
        self.run_check((0.9, 100), advance=1)
        self.assertEqual(self.send.call_count, 2)
        self.assertIn("possible repeat", self.send.call_args.args[1])

    def test_corrupt_oversized_unsafe_state_preserved(self):
        path = self.directory / "state.json"
        for body in (b"bad", b"[]", b"[" * 2000, b" " * (watchdog.MAX_STATE + 1)):
            path.write_bytes(body)
            path.chmod(0o600)
            with self.assertRaises((ValueError, RecursionError)):
                self.run_check((0.9, 100))
            self.assertEqual(path.read_bytes(), body)
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            self.run_check()
        path.unlink()
        path.symlink_to(self.directory / "missing")
        with self.assertRaises(OSError):
            self.run_check()
        self.send.assert_not_called()

    def test_oversized_timestamps_rejected_without_sending_or_replacing_state(self):
        path = self.directory / "state.json"
        for field in ("incident", "retry"):
            for value in (10**400, -(10**400)):
                state = watchdog.initial_state()
                check = state["checks"]["disk"]
                check.update(active=True, incident=self.now)
                check["notice"] = {"kind": "alert", "outcome": "unknown",
                                   "retry": self.now + 1800, "possible": True}
                target = check if field == "incident" else check["notice"]
                target[field] = value
                body = json.dumps(state).encode()
                self.assertLess(len(body), watchdog.MAX_STATE)
                path.write_bytes(body)
                path.chmod(0o600)
                with self.subTest(field=field, negative=value < 0), self.assertRaises(ValueError):
                    self.run_check((0.9, 100))
                self.assertEqual(path.read_bytes(), body)
        self.send.assert_not_called()

    def test_schema_rejects_wrong_types_and_inconsistent_notices(self):
        for key, value in (("active", 1), ("failures", -1), ("successes", 999),
                           ("incident", float("nan")), ("alert_possible", "yes"),
                           ("notice", {"kind": "alert", "outcome": "unknown", "retry": 0})):
            state = watchdog.initial_state()
            state["checks"]["disk"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                watchdog.validate_state(state)

    def test_unwritable_and_atomic_replace_failure_prevent_post_preserve_previous(self):
        self.run_check()
        before = (self.directory / "state.json").read_bytes()
        for target in ("mkstemp", "replace", "fsync"):
            owner = watchdog.tempfile if target == "mkstemp" else watchdog.os
            with patch.object(owner, target, side_effect=OSError("private")), self.assertRaises(OSError):
                self.run_check((0.9, 100))
            self.assertEqual((self.directory / "state.json").read_bytes(), before)
            self.assertEqual(list(self.directory.glob(".state-*")), [])
        self.send.assert_not_called()

    def test_failed_outcome_save_leaves_unknown_intent(self):
        save = watchdog.save_state
        calls = 0
        def fail_second(directory, state):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("private")
            save(directory, state)
        with patch.object(watchdog, "save_state", side_effect=fail_second), self.assertRaises(OSError):
            self.run_check((0.9, 100))
        self.assertEqual(self.state()["checks"]["disk"]["notice"]["outcome"], "unknown")
        self.run_check((0.9, 100))
        self.assertEqual(self.send.call_count, 1)

    def test_overlapping_run_does_not_probe_or_send(self):
        with (self.directory / "lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.run_check((0.9, 100)), "already running")
        self.send.assert_not_called()
        self.assertFalse((self.directory / "state.json").exists())

    def test_readiness_contract_and_bounded_read(self):
        for status, body, expected in ((200, b'{"status":"ready"}', True),
                                      (401, b'{"status":"ready"}', False),
                                      (503, b'{"status":"unavailable"}', False),
                                      (302, b'{}', False), (200, b'broken', False),
                                      (200, b' ' * 257, False), (200, b'[]', False)):
            connection = MagicMock()
            connection.getresponse.return_value.status = status
            connection.getresponse.return_value.read.return_value = body
            with patch.object(watchdog.http.client, "HTTPConnection", return_value=connection):
                self.assertEqual(watchdog.readiness("fake"), expected)
            connection.request.assert_called_once_with("GET", "/readyz", headers={"Authorization": "Bearer fake"})
            connection.getresponse.return_value.read.assert_called_once_with(257)
            connection.close.assert_called_once()

    def test_readiness_total_deadline_with_local_stalled_and_trickling_http(self):
        for trickle in (False, True):
            with self.subTest(trickle=trickle), socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen(1)
                listener.settimeout(2)
                stopped = threading.Event()
                requests = []
                def serve():
                    with listener.accept()[0] as client:
                        client.settimeout(2)
                        requests.append(client.recv(4096))
                        if trickle:
                            client.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 256\r\n\r\n")
                            while not stopped.wait(0.02):
                                try:
                                    client.sendall(b" ")
                                except OSError:
                                    break
                        else:
                            stopped.wait(2)
                thread = threading.Thread(target=serve, daemon=True)
                thread.start()
                connection = http.client.HTTPConnection(*listener.getsockname(), timeout=2)
                started = time.monotonic()
                try:
                    with patch.object(watchdog, "READY_TIMEOUT", 0.15), \
                            patch.object(watchdog.http.client, "HTTPConnection", return_value=connection):
                        self.assertFalse(watchdog.readiness("fake-token"))
                    self.assertLess(time.monotonic() - started, 1)
                    self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0, 0))
                finally:
                    stopped.set()
                    thread.join(3)
                self.assertFalse(thread.is_alive())
                self.assertEqual(len(requests), 1)

    def test_cli_state_error_is_sanitized(self):
        output = io.StringIO()
        with patch.dict(watchdog.os.environ, self.config, clear=True), \
                patch.object(watchdog.os, "geteuid", return_value=0), \
                patch.object(watchdog, "secure_file", side_effect=OSError("private secret")), \
                contextlib.redirect_stderr(output):
            self.assertEqual(watchdog.main(["--check"]), 2)
        self.assertEqual(output.getvalue(), "watchdog: configuration or state unavailable\n")


if __name__ == "__main__":
    unittest.main()
