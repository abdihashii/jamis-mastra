#!/usr/bin/env python3
"""Standalone host notification. Run on Unix in the main thread."""

import argparse
import http.client
import json
import os
import re
import signal
import sys
from datetime import datetime, timezone

SEND_TIMEOUT = 15
MAX_RESPONSE = 16384
CREDENTIALS = ("SENDBLUE_API_KEY", "SENDBLUE_API_SECRET",
               "SENDBLUE_FROM_NUMBER", "JAMIS_ALLOWED_NUMBER")


def classify_response(status, body):
    if 400 <= status < 500:
        return "rejected"
    if not 200 <= status < 300 or len(body) > MAX_RESPONSE:
        return "unknown"
    try:
        data = json.loads(body)
    except (ValueError, UnicodeError, RecursionError):
        return "unknown"
    if not isinstance(data, dict):
        return "unknown"
    provider_status = data.get("status")
    code = data.get("error_code")
    error = data.get("error_message")
    if provider_status == "ERROR":
        return "rejected"
    if (provider_status in ("QUEUED", "SENT", "DELIVERED")
            and isinstance(data.get("message_handle"), str)
            and data["message_handle"].strip()
            and (code is None or type(code) is int and code == 0)
            and error in (None, "")):
        return "accepted"
    return "unknown"


def _deadline(signum, frame):
    raise TimeoutError("notification deadline")


def send_notification(config, message):
    """One POST, no redirects/retries; acceptance does not establish receipt."""
    connection = None
    previous = signal.signal(signal.SIGALRM, _deadline)
    signal.setitimer(signal.ITIMER_REAL, SEND_TIMEOUT)
    try:
        connection = http.client.HTTPSConnection("api.sendblue.co", timeout=SEND_TIMEOUT)
        connection.request("POST", "/api/send-message", body=json.dumps({
            "number": config["JAMIS_ALLOWED_NUMBER"],
            "from_number": config["SENDBLUE_FROM_NUMBER"],
            "content": message,
        }).encode("utf-8"), headers={
            "Content-Type": "application/json",
            "sb-api-key-id": config["SENDBLUE_API_KEY"],
            "sb-api-secret-key": config["SENDBLUE_API_SECRET"],
        })
        response = connection.getresponse()
        if 400 <= response.status < 500:
            return "rejected"
        if not 200 <= response.status < 300:
            return "unknown"
        return classify_response(response.status, response.read(MAX_RESPONSE + 1))
    except (OSError, http.client.HTTPException, ValueError):
        return "unknown"
    finally:
        if connection is not None:
            connection.close()
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test-notification", action="store_true", required=True,
                        help="send one labeled test DM to the configured Operator")
    parser.parse_args(argv)
    config = {key: os.environ.get(key, "").strip() for key in CREDENTIALS}
    if (any(not value or len(value) > 512 or not value.isascii()
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
            for value in config.values())
            or any(not re.fullmatch(r"\+[1-9][0-9]{6,14}", config[key])
                   for key in CREDENTIALS[2:])):
        print("watchdog: invalid notification configuration", file=sys.stderr)
        return 2
    observed = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    outcome = send_notification(config, "JAMIS WATCHDOG TEST: standalone host notification. "
                                "No incident detected by this test. Observed UTC: " + observed)
    print("watchdog: test notification " + outcome)
    return 0 if outcome == "accepted" else 1


if __name__ == "__main__":
    sys.exit(main())
