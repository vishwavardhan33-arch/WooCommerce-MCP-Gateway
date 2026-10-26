#!/usr/bin/env bash
# Idempotent provisioning for the store. Runs as a Helm post-install/post-upgrade hook Job.
# Every step looks at the current state first and only changes what differs, so running it
# twice (or after a half-finished run) is safe. It ENFORCES these settings on every run:
# changes made in wp-admin to the same settings are reset on the next helm upgrade.
set -euo pipefail

log() { echo "[provision] $*"; }

# Capture the real wp-cli path BEFORE the wp() function below shadows the name.
WP_PHAR="$(command -v wp)"
# php -d: WooCommerce activation can exceed PHP CLI's default 128M memory limit.
wp() { php -d memory_limit=512M "$WP_PHAR" --path=/var/www/html "$@"; }

command -v curl >/dev/null || { log "FAIL: curl is not available in this image"; exit 1; }

# ---- 1. wait for the WordPress pod to populate the volume, and for the database -------------
# wp-config.php is created by the WordPress container AFTER it has copied the core files,
# so its presence means the volume is ready.
db_up() {
  php -r 'exit(@mysqli_connect(getenv("WORDPRESS_DB_HOST"), getenv("WORDPRESS_DB_USER"), getenv("WORDPRESS_DB_PASSWORD"), getenv("WORDPRESS_DB_NAME")) ? 0 : 1);' 2>/dev/null
}
log "waiting for wp-config.php and the database"
ready=0
for _ in $(seq 1 120); do
  if [ -f /var/www/html/wp-config.php ] && db_up; then ready=1; break; fi
  sleep 5
done
[ "$ready" = 1 ] || { log "FAIL: WordPress files or database not ready after 10 minutes"; exit 1; }

# ---- 2. install WordPress core ---------------------------------------------------------------
if wp core is-installed; then
  log "core already installed"
else
  log "installing core"
  wp core install --url="$SITE_URL" --title="$SITE_TITLE" \
    --admin_user="$ADMIN_USER" --admin_password="$WP_ADMIN_PASSWORD" \
    --admin_email="$ADMIN_EMAIL" --skip-email
fi

# ---- 3. pretty permalinks (needed for /wp-json/... and the checkout API) --------------------
# Soft flush only: the image already wrote an .htaccess with the front-controller rewrite rule.
if [ "$(wp option get permalink_structure 2>/dev/null || true)" != "/%postname%/" ]; then
  log "setting pretty permalinks"
  wp rewrite structure '/%postname%/'
fi

# ---- 4. WooCommerce at the pinned version ----------------------------------------------------
have="$(wp plugin get woocommerce --field=version 2>/dev/null || true)"
if [ "$have" != "$WC_VERSION" ]; then
  log "installing WooCommerce $WC_VERSION (found: ${have:-none})"
  wp plugin install woocommerce --version="$WC_VERSION" --force
fi
wp plugin is-active woocommerce || wp plugin activate woocommerce

# ---- 5. store settings and demo products (COD, no shipping, shop open, 4 products) ---------
wp eval-file /scripts/seed.php

# ---- 6. the bot user the MCP server acts as --------------------------------------------------
if wp user get "$BOT_USER" >/dev/null 2>&1; then
  log "user $BOT_USER exists"
else
  log "creating user $BOT_USER"
  # No --user_pass: wp-cli generates a random one. Nobody logs in with it; only the
  # Application Password below is used.
  wp user create "$BOT_USER" "${BOT_USER}@example.invalid" --role=shop_manager --porcelain >/dev/null
fi
wp user set-role "$BOT_USER" shop_manager   # enforce the role on every run

# ---- 7. Application Password -> Kubernetes Secret --------------------------------------------
# WordPress shows an Application Password only once, at creation. bot.php therefore keeps the one in
# the Secret if it still verifies, and otherwise issues a new one and writes it to $APP_PASSWORD_OUT.
write_secret() {
  local password="$1" sa=/var/run/secrets/kubernetes.io/serviceaccount body code
  local api="https://kubernetes.default.svc/api/v1/namespaces/${NAMESPACE}/secrets"
  # stringData: send plain text, the API server stores it base64-encoded.
  body="$(printf '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"%s"},"type":"Opaque","stringData":{"username":"%s","password":"%s"}}' \
    "$BOT_SECRET" "$BOT_USER" "$password")"
  kube() { # <content-type> <method> <url>
    curl -sS -o /tmp/kube-response -w '%{http_code}' --cacert "$sa/ca.crt" \
      -H "Authorization: Bearer $(cat "$sa/token")" -H "Content-Type: $1" -X "$2" "$3" --data "$body"
  }
  code="$(kube application/json POST "$api")"
  if [ "$code" = 409 ]; then   # already exists -> update it in place
    code="$(kube application/merge-patch+json PATCH "$api/$BOT_SECRET")"
  fi
  case "$code" in
    200|201) rm -f /tmp/kube-response; log "secret/$BOT_SECRET written" ;;
    *) log "FAIL: Kubernetes API answered HTTP $code"; cat /tmp/kube-response >&2; exit 1 ;;
  esac
}

rm -f "$APP_PASSWORD_OUT"
wp eval-file /scripts/bot.php
if [ -s "$APP_PASSWORD_OUT" ]; then
  write_secret "$(cat "$APP_PASSWORD_OUT")"
  rm -f "$APP_PASSWORD_OUT"
fi

# Rewrite rules registered by WooCommerce only exist after a flush.
wp rewrite flush
log "done"
