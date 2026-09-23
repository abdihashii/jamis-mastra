#!/usr/bin/env python3
"""One fixed, socket-activated read of host and Jamis Compose state."""

import json
import subprocess
import sys
from datetime import datetime, timezone

SERVICES = ("app", "postgres", "clickhouse", "cloudflared")
STATES = {"created", "running", "restarting", "exited", "paused", "dead", "removing"}
DOCKER_COMMAND = (
    "/usr/bin/docker", "ps", "--all", "--filter",
    "label=com.docker.compose.project=jamis",
    "--format", '{{.Label "com.docker.compose.service"}}\t{{.State}}',
)


def _read(path, limit):
    with open(path, encoding="ascii") as source:
        value = source.read(limit + 1)
    if len(value) > limit:
        raise ValueError("source too large")
    return value


def _host(observed_at):
    result = {
        "component": "host", "source": "procfs", "observedAt": observed_at,
        "scope": "current", "availability": "unavailable",
        "memoryAvailableMiB": None, "load1": None, "uptimeSeconds": None,
        "gaps": ["host_probe_unavailable"],
    }
    try:
        memory = next(line for line in _read("/proc/meminfo", 4096).splitlines()
                      if line.startswith("MemAvailable:"))
        memory_kib = int(memory.split()[1])
        load = float(_read("/proc/loadavg", 128).split()[0])
        uptime = int(float(_read("/proc/uptime", 128).split()[0]))
        if not (0 <= memory_kib <= 1_024_000_000 and 0 <= load <= 10_000 and 0 <= uptime <= 10_000_000_000):
            raise ValueError("out of range")
        result.update(availability="available", memoryAvailableMiB=memory_kib // 1024,
                      load1=round(load, 2), uptimeSeconds=uptime,
                      gaps=["external_reachability", "recent_host_events"])
    except (OSError, ValueError, IndexError, StopIteration):
        pass
    return result


def _docker_states(raw):
    states = {service: "missing" for service in SERVICES}
    seen = set()
    for line in raw.splitlines():
        fields = line.split("\t")
        if len(fields) != 2 or fields[0] not in states:
            continue
        service, state = fields
        states[service] = "unknown" if service in seen or state not in STATES else state
        seen.add(service)
    return [{"component": service, "state": states[service]} for service in SERVICES]


def _docker(observed_at):
    result = {
        "component": "docker", "source": "docker_engine", "observedAt": observed_at,
        "scope": "current", "availability": "unavailable", "containers": [],
        "gaps": ["docker_probe_unavailable"],
    }
    try:
        check = subprocess.run(DOCKER_COMMAND, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True, timeout=2, check=False)
        if check.returncode != 0 or len(check.stdout) > 4096:
            return result
        result.update(availability="available", containers=_docker_states(check.stdout),
                      gaps=["service_functionality", "external_reachability"])
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        pass
    return result


def probe():
    observed_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    return {"host": _host(observed_at), "docker": _docker(observed_at)}


if __name__ == "__main__":
    # Socket activation connects stdout directly to one caller. Input is ignored.
    sys.stdout.write(json.dumps(probe(), separators=(",", ":")) + "\n")
