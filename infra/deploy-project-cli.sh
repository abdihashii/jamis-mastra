#!/usr/bin/env bash
# Host-owned deployment boundary, also exercised by the disposable Compose smoke.
# Run from the checkout after .env.prod validation and evidence-socket setup.
set -eEuo pipefail

# Atomic host admission prevents two deployments from switching/retiring views concurrently.
# ponytail: interrupted hosts may leave this lock; Operator removes it only after confirming all related Docker work and worker cleanup stopped.
mkdir -p .project-view
if ! mkdir .project-view/deploy.lock; then
  echo 'Project deployment already active or interrupted; views retained.' >&2
  exit 1
fi
trap 'rmdir .project-view/deploy.lock' EXIT
# Docker/Compose may keep working after its parent receives a signal. Keep host
# admission closed rather than claim that those operations have stopped.
trap 'trap - EXIT ERR; echo "Project deployment interrupted; lock and views retained." >&2; exit 1' HUP INT TERM

compose() {
  docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml "$@"
}
prepare() {
  docker run --rm --mount "type=bind,source=$PWD,target=/checkout" -w /checkout \
    oven/bun:1.3.14-alpine bun scripts/prepare-project-view.ts "$@"
}

# Nothing live stops until preparation and all builds succeed. Resolve once for
# both mounts and jq's descriptor, never follow current during replacement.
prepare
export PROJECT_VIEW_HOST_PATH="$(realpath .project-view/current)"
export PROJECT_CLI_VIEW="$(cat "$PROJECT_VIEW_HOST_PATH/.project-view.json")"
compose build app project-rg project-jq
compose up -d postgres clickhouse

# SIGTERM closes worker admission and drains the current deadline. A forced
# stop or ambiguous shutdown retains all generations and disables CLI.
compose stop project-rg project-jq
trap 'compose stop project-rg project-jq >&2 || { trap - EXIT; echo "Worker shutdown unavailable; lock and views retained." >&2; }' ERR
for service in project-rg project-jq; do
  container="$(compose ps -aq "$service")"
  if [ -n "$container" ]; then
    state="$(docker inspect --format '{{.State.Running}} {{.State.Pid}} {{.State.ExitCode}}' "$container")"
    if [ "$state" != 'false 0 0' ]; then
      echo "Worker shutdown not confirmed: $service. Views retained; CLI unavailable." >&2
      exit 1
    fi
  fi
done

compose up -d --no-deps --force-recreate project-rg project-jq
compose up -d --no-deps --force-recreate app
# This owner-level check returns only bounded status metadata. Failure stops the
# replacement workers and preserves views, including any surviving native mount.
if ! compose exec -T app bun --no-env-file project-cli/scripts/project-cli-check.ts; then
  compose stop project-rg project-jq
  exit 1
fi
prepare --cleanup . "$(basename "$PROJECT_VIEW_HOST_PATH")"
