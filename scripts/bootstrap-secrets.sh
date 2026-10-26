#!/usr/bin/env bash
# Creates the Kubernetes Secrets the Helm charts expect, from a local .env file.
#
# Why a script and not Helm values: values files are committed to git and show up in
# `helm get values`, so secrets never go there. Charts only REFERENCE these Secrets by name.
#
# Safe to re-run: `create --dry-run | apply` updates a Secret in place.
#
# Secret name        -> keys
#   store-db         -> MYSQL_ROOT_PASSWORD, MYSQL_PASSWORD
#   store-wordpress  -> WP_ADMIN_PASSWORD
#   gateway-db       -> POSTGRES_PASSWORD
#   gateway-app      -> SESSION_SECRET, ADMIN_BOOTSTRAP_PASSWORD, CREDENTIAL_ENC_KEY,
#                       LLM_BASE_URL, LLM_MODEL, LLM_API_KEY   (chat; may be empty = chat disabled)
#   woo-mcp          -> MCP_AUTH_TOKEN
#   mcp-fx           -> MCP_AUTH_TOKEN   (from FX_MCP_AUTH_TOKEN)
#   mcp-notes        -> MCP_AUTH_TOKEN   (from NOTES_MCP_AUTH_TOKEN)
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
NAMESPACE="${NAMESPACE:-platform}"
# Explicit context: refuses to guess, so a stray `kubectl config use-context` can't redirect us.
# On the VPS run with KUBE_CONTEXT=<your k3s context>.
KUBE_CONTEXT="${KUBE_CONTEXT:-k3d-woo-mcp}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

# `set -a` exports everything the file defines; we only read the values back below.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

kc() { kubectl --context "$KUBE_CONTEXT" "$@"; }

# Fail early, naming every empty variable, before touching the cluster.
require() {
  local missing=0 v
  for v in "$@"; do
    if [[ -z "${!v:-}" ]]; then
      echo "error: $v is empty in $ENV_FILE" >&2
      missing=1
    fi
  done
  if [[ "$missing" -eq 1 ]]; then exit 1; fi
}

require MYSQL_ROOT_PASSWORD MYSQL_PASSWORD WP_ADMIN_PASSWORD \
  POSTGRES_PASSWORD SESSION_SECRET ADMIN_BOOTSTRAP_PASSWORD CREDENTIAL_ENC_KEY MCP_AUTH_TOKEN \
  FX_MCP_AUTH_TOKEN NOTES_MCP_AUTH_TOKEN

# Values go through a private temp file (mktemp creates it mode 600), never through
# command-line arguments, because arguments are visible to other users in `ps`.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# apply_secret <secret-name> <ENV_VAR | KEY=ENV_VAR>...
# Plain ENV_VAR: the Secret key has the same name. KEY=ENV_VAR: the Secret key is KEY, filled from
# ENV_VAR (the three MCP servers all use the key MCP_AUTH_TOKEN, but each needs its own token).
apply_secret() {
  local name="$1" arg key var
  shift
  : > "$TMP"
  for arg in "$@"; do
    key="${arg%%=*}" # text before the first "="  (the whole argument when there is no "=")
    var="${arg#*=}"  # text after the first "="   (the whole argument when there is no "=")
    printf '%s=%s\n' "$key" "${!var:-}" >> "$TMP"
  done
  kc -n "$NAMESPACE" create secret generic "$name" \
    --from-env-file="$TMP" --dry-run=client -o yaml | kc apply -f - > /dev/null
  echo "ok: secret/$name"
}

echo "context=$KUBE_CONTEXT namespace=$NAMESPACE"

# Helm's --create-namespace tolerates a namespace that already exists, so creating it here is safe.
kc create namespace "$NAMESPACE" --dry-run=client -o yaml | kc apply -f - > /dev/null

apply_secret store-db        MYSQL_ROOT_PASSWORD MYSQL_PASSWORD
apply_secret store-wordpress WP_ADMIN_PASSWORD
apply_secret gateway-db      POSTGRES_PASSWORD
apply_secret gateway-app     SESSION_SECRET ADMIN_BOOTSTRAP_PASSWORD CREDENTIAL_ENC_KEY LLM_BASE_URL LLM_MODEL LLM_API_KEY
apply_secret woo-mcp         MCP_AUTH_TOKEN
apply_secret mcp-fx        MCP_AUTH_TOKEN=FX_MCP_AUTH_TOKEN
apply_secret mcp-notes     MCP_AUTH_TOKEN=NOTES_MCP_AUTH_TOKEN
