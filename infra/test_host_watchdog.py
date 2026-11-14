import contextlib
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


if __name__ == "__main__":
    unittest.main()
