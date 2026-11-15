#!/usr/bin/env python3
"""Host disk/readiness watchdog. Run on Unix in the main thread."""

import argparse
import fcntl
import math
import http.client
import json
import os
import re
import signal
import sys
import stat
import tempfile
import time
from pathlib import Path
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


READY_TIMEOUT = 5
STATE_DIRECTORY = Path("/var/lib/jamis-watchdog")
MAX_STATE = 8192


def readiness(token):
    connection = None
    previous = signal.signal(signal.SIGALRM, _deadline)
    signal.setitimer(signal.ITIMER_REAL, READY_TIMEOUT)
    try:
        connection = http.client.HTTPConnection("127.0.0.1", 4111, timeout=READY_TIMEOUT)
        connection.request("GET", "/readyz", headers={"Authorization": "Bearer " + token})
        response = connection.getresponse()
        body = response.read(257)
        return response.status == 200 and len(body) <= 256 and json.loads(body) == {"status": "ready"}
    except (OSError, http.client.HTTPException, ValueError, RecursionError):
        return False
    finally:
        if connection is not None:
            connection.close()
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def disk_usage():
    try:
        fs = os.statvfs("/")
        used = fs.f_blocks - fs.f_bfree
        total = used + fs.f_bavail
        if used < 0 or fs.f_bavail < 0 or total <= 0:
            return None
        return used / total, fs.f_bavail * fs.f_frsize
    except OSError:
        return None


def initial_state():
    return {"version": 1, "checks": {name: {
        "active": False, "failures": 0, "successes": 0, "incident": None,
        "alert_possible": False, "notice": None,
    } for name in ("disk", "readiness")}}


def valid_time(value):
    return type(value) in (int, float) and 0 <= value <= 253402300799 and math.isfinite(value)


def validate_state(state):
    if (not isinstance(state, dict) or set(state) != {"version", "checks"}
            or type(state["version"]) is not int or state["version"] != 1
            or not isinstance(state["checks"], dict)
            or set(state["checks"]) != {"disk", "readiness"}):
        raise ValueError("invalid state")
    for check in state["checks"].values():
        if (not isinstance(check, dict) or set(check) != set(initial_state()["checks"]["disk"])
                or type(check["active"]) is not bool or type(check["alert_possible"]) is not bool
                or any(type(check[key]) is not int or not 0 <= check[key] <= 3
                       for key in ("failures", "successes"))
                or check["incident"] is not None and not valid_time(check["incident"])
                or check["active"] and check["incident"] is None):
            raise ValueError("invalid check")
        notice = check["notice"]
        if notice is not None:
            if (not isinstance(notice, dict) or set(notice) != {"kind", "outcome", "retry", "possible"}
                    or notice["kind"] != ("alert" if check["active"] else "recovery")
                    or notice["outcome"] not in ("pending", "accepted", "rejected", "unknown")
                    or type(notice["possible"]) is not bool
                    or not valid_time(notice["retry"]) or check["incident"] is None):
                raise ValueError("invalid notice")
    return state


def secure_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError("unsafe file")
        return fd
    except BaseException:
        os.close(fd)
        raise


def load_state(directory):
    try:
        fd = secure_file(directory / "state.json")
    except FileNotFoundError:
        return initial_state()
    with os.fdopen(fd, "rb") as stream:
        body = stream.read(MAX_STATE + 1)
    if len(body) > MAX_STATE:
        raise ValueError("oversized state")
    return validate_state(json.loads(body))


def save_state(directory, state):
    body = json.dumps(validate_state(state), allow_nan=False).encode()
    fd, temporary = tempfile.mkstemp(prefix=".state-", dir=directory)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, directory / "state.json")
        directory_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def observe(check, active, now):
    if active == check["active"]:
        return
    check["active"] = active
    if active:
        check["incident"] = now
        check["alert_possible"] = False
    check["notice"] = ({"kind": "alert" if active else "recovery", "outcome": "pending", "retry": 0, "possible": False}
                       if active or check["alert_possible"] else None)


def update_checks(state, disk, ready, now):
    checks = state["checks"]
    if disk is not None:
        usage, _ = disk
        if usage >= 0.85:
            observe(checks["disk"], True, now)
        elif usage < 0.80:
            observe(checks["disk"], False, now)
    check = checks["readiness"]
    check["successes"] = min(2, check["successes"] + 1) if ready else 0
    check["failures"] = 0 if ready else min(3, check["failures"] + 1)
    if check["failures"] == 3:
        observe(check, True, now)
    elif check["successes"] == 2:
        observe(check, False, now)


def utc(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def run_checks(config, directory=STATE_DIRECTORY):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("unsafe directory")
    lock_fd = os.open(directory / "lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(lock_fd, "r+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return "already running"
        state = load_state(directory)
        disk = disk_usage()
        ready = readiness(config["API_TOKEN"])
        now = time.time()
        update_checks(state, disk, ready, now)
        eligible = [name for name, check in state["checks"].items()
                    if check["notice"] is not None and check["notice"]["outcome"] != "accepted"
                    and check["notice"]["retry"] <= now
                    and (name != "disk" or disk is not None)]
        if not eligible:
            save_state(directory, state)
            return "disk unavailable" if disk is None else "checked"
        lines = ["JAMIS WATCHDOG", "Observed UTC: " + utc(now)]
        previous_possible = {}
        previous_notice_possible = {}
        for name in eligible:
            check = state["checks"][name]
            notice = check["notice"]
            repeat = " (possible repeat of an earlier notification)" if notice["possible"] else ""
            fact = (f"root usage {disk[0]:.1%}, available {disk[1]} bytes" if name == "disk" else
                    f"readiness {'ready' if ready else 'unavailable'}, failures {check['failures']}, successes {check['successes']}")
            lines.append(f"{name} {notice['kind']}{repeat}: {fact}; incident UTC: {utc(check['incident'])}")
            previous_possible[name] = check["alert_possible"]
            previous_notice_possible[name] = notice["possible"]
            if notice["kind"] == "alert":
                check["alert_possible"] = True
            # A crash after this durable intent leaves acceptance unknown.
            notice.update(outcome="unknown", retry=now + 1800, possible=True)
        save_state(directory, state)
        outcome = send_notification(config, "\n".join(lines))
        for name in eligible:
            check = state["checks"][name]
            notice = check["notice"]
            notice.update(outcome=outcome, retry=time.time() + (300 if outcome == "rejected" else 1800) if outcome != "accepted" else 0)
            if outcome == "rejected":
                notice["possible"] = previous_notice_possible[name]
                if notice["kind"] == "alert":
                    check["alert_possible"] = previous_possible[name]
        save_state(directory, state)
        return "notification " + outcome


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--test-notification", action="store_true", help="send one labeled test DM")
    modes.add_argument("--check", action="store_true", help="run persistent host checks")
    modes.add_argument("--check-config", action="store_true", help="validate host credentials without sending")
    args = parser.parse_args(argv)
    keys = CREDENTIALS if args.test_notification else (*CREDENTIALS, "API_TOKEN")
    config = {key: os.environ.get(key, "").strip() for key in keys}
    if (any(not value or len(value) > 512 or not value.isascii()
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
            for value in config.values())
            or any(not re.fullmatch(r"\+[1-9][0-9]{6,14}", config[key])
                   for key in CREDENTIALS[2:])):
        print("watchdog: invalid notification configuration", file=sys.stderr)
        return 2
    if not args.test_notification:
        try:
            if os.geteuid() != 0:
                raise ValueError("requires root")
            os.close(secure_file(Path("/etc/jamis/watchdog.env")))
            result = "configuration valid" if args.check_config else run_checks(config)
            print("watchdog: " + result)
            return 0
        except (OSError, ValueError, RecursionError):
            print("watchdog: configuration or state unavailable", file=sys.stderr)
            return 2
    outcome = send_notification(config, "JAMIS WATCHDOG TEST: standalone host notification. "
                                "No incident detected by this test. Observed UTC: " + utc(time.time()))
    print("watchdog: test notification " + outcome)
    return 0 if outcome == "accepted" else 1


if __name__ == "__main__":
    sys.exit(main())
