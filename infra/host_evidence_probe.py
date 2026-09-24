#!/usr/bin/env python3
"""One fixed, socket-activated read of host and local service state."""

import json
import subprocess
import sys
from datetime import datetime, timezone

SERVICES = ("app", "postgres", "clickhouse", "cloudflared")
STATES = {"created", "running", "restarting", "exited", "paused", "dead", "removing"}
SERVICE_STATES = {"active", "inactive", "failed", "activating", "deactivating"}
TAILSCALE_STATES = {"Running", "Starting", "Stopped", "NeedsLogin", "NeedsMachineAuth"}
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


def _tunnel(observed_at, docker):
    result = {
        "component": "cloudflare_tunnel", "source": "local_cloudflared",
        "observedAt": observed_at, "scope": "current_and_recent_5m",
        "availability": "unavailable", "containerState": "unknown",
        "recentDiagnostic": "unknown", "gaps": ["tunnel_probe_unavailable"],
    }
    if docker["availability"] != "available":
        return result
    state = next(container["state"] for container in docker["containers"]
                 if container["component"] == "cloudflared")
    result.update(availability="available", containerState=state,
                  gaps=["external_reachability", "recent_tunnel_diagnostics_unavailable"])
    if state != "running":
        return result
    try:
        check = subprocess.run(
            ("/usr/bin/docker", "logs", "--since", "5m", "--tail", "20", "jamis-cloudflared-1"),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=2, check=False,
        )
        if check.returncode != 0 or len(check.stdout) > 8192:
            return result
        diagnostic = "none_observed"
        for line in check.stdout.lower().splitlines():
            if "registered tunnel connection" in line:
                diagnostic = "connection_registered"
            elif "failed to" in line or "error" in line:
                diagnostic = "local_error"
        result.update(recentDiagnostic=diagnostic, gaps=["external_reachability"])
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        pass
    return result


def _tailscale(observed_at):
    result = {
        "component": "tailscale", "source": "local_tailscale",
        "observedAt": observed_at, "scope": "current",
        "availability": "unavailable", "serviceState": "unknown",
        "backendState": "unknown", "gaps": ["tailscale_probe_unavailable"],
    }
    try:
        service = subprocess.run(
            ("/usr/bin/systemctl", "is-active", "tailscaled"),
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=2, check=False,
        )
        state = service.stdout.strip()
        if state not in SERVICE_STATES:
            return result
        result.update(availability="available", serviceState=state,
                      gaps=["operator_device_reachability", "tailscale_status_unavailable"])
        if state != "active":
            return result
        status = subprocess.run(
            ("/usr/bin/tailscale", "status", "--json"),
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=2, check=False,
        )
        if status.returncode != 0 or len(status.stdout) > 65536:
            return result
        status_data = json.loads(status.stdout)
        backend = status_data.get("BackendState") if isinstance(status_data, dict) else None
        if isinstance(backend, str) and backend in TAILSCALE_STATES:
            result.update(backendState=backend, gaps=["operator_device_reachability"])
    except (OSError, subprocess.TimeoutExpired, UnicodeError, ValueError):
        pass
    return result


def probe():
    observed_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    docker = _docker(observed_at)
    return {"host": _host(observed_at), "docker": docker,
            "cloudflareTunnel": _tunnel(observed_at, docker),
            "tailscale": _tailscale(observed_at)}


if __name__ == "__main__":
    # Socket activation connects stdout directly to one caller. Input is ignored.
    sys.stdout.write(json.dumps(probe(), separators=(",", ":")) + "\n")
