#!/usr/bin/env bash
# Pulls the Node base image for the CI Docker builds and prints the reference
# that worked, for `docker build --build-arg NODE_BASE_IMAGE=...`.
#
# The Dockerfiles default to ECR Public's copy of the official image (what
# Render builds with). Anonymous pulls from shared GitHub runner IPs hit ECR
# Public's per-IP data limit (429 "toomanyrequests: Data limit exceeded"), so
# CI tries mirrors of the same official Docker Hub image first, each with
# retries: Google's Docker Hub mirror, Docker Hub itself, then ECR Public.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
default_of() { sed -n 's/^ARG NODE_BASE_IMAGE=//p' "$1"; }
mcp_default="$(default_of "$root/apps/mcp-server/Dockerfile")"
console_default="$(default_of "$root/apps/console/Dockerfile")"
if [ -z "$mcp_default" ] || [ "$mcp_default" != "$console_default" ]; then
  echo "pull-base-image: the two Dockerfiles must declare the same ARG NODE_BASE_IMAGE default" >&2
  exit 1
fi
case "$mcp_default" in
  public.ecr.aws/docker/library/*) tag="${mcp_default#public.ecr.aws/docker/library/}" ;;
  *) echo "pull-base-image: unexpected default $mcp_default (expected an official library image)" >&2; exit 1 ;;
esac

for ref in "mirror.gcr.io/library/$tag" "docker.io/library/$tag" "$mcp_default"; do
  for attempt in 1 2 3; do
    if docker pull --quiet "$ref" >&2; then
      echo "pull-base-image: using $ref" >&2
      echo "$ref"
      exit 0
    fi
    echo "pull-base-image: $ref failed (attempt $attempt)" >&2
    sleep $((attempt * 5))
  done
done
echo "pull-base-image: no registry served $tag" >&2
exit 1
