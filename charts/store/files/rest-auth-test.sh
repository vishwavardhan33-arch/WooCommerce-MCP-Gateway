#!/bin/sh
# `helm test`: proves how REST authentication behaves over plain in-cluster HTTP.
# Needs env: WP_URL, BOT_USER, BOT_PASSWORD, MIN_PRODUCTS
set -eu

URL="$WP_URL/wp-json/wc/v3/products"
fail() { echo "FAIL: $*"; exit 1; }
status() { curl -s --max-time 30 -o /dev/null -w '%{http_code}' "$@"; }

echo "1) no credentials -> expect 401"
code="$(status "$URL")"
[ "$code" = 401 ] || fail "expected 401, got $code"

echo "2) valid application password over plain HTTP, WITHOUT X-Forwarded-Proto -> expect 401"
echo "   (WordPress ignores Application Passwords unless it believes the request is HTTPS)"
code="$(status -u "$BOT_USER:$BOT_PASSWORD" "$URL")"
[ "$code" = 401 ] || fail "expected 401, got $code (is the premise of the X-Forwarded-Proto approach wrong?)"

echo "3) valid application password + 'X-Forwarded-Proto: https' -> expect 200 and product data"
code="$(curl -s --max-time 30 -o /tmp/body -w '%{http_code}' -u "$BOT_USER:$BOT_PASSWORD" -H 'X-Forwarded-Proto: https' "$URL")"
[ "$code" = 200 ] || { head -c 300 /tmp/body; echo; fail "expected 200, got $code"; }
count="$(grep -o '"sku":"[^"]' /tmp/body | wc -l)"
echo "   HTTP 200, $count products with a SKU. First bytes of the response:"
head -c 200 /tmp/body; echo
[ "$count" -ge "$MIN_PRODUCTS" ] || fail "expected at least $MIN_PRODUCTS products, got $count"

echo "PASS"
