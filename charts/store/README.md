# store chart

One WooCommerce store: WordPress (official image), MariaDB, and a hook Job that sets the store up
the same way every time.

| Piece | Kind | Notes |
|---|---|---|
| WordPress | Deployment (1 replica, `Recreate`) + Service + PVC | `/var/www/html` is on a ReadWriteOnce volume |
| MariaDB | StatefulSet + headless Service | PVC from `volumeClaimTemplates` |
| Ingress | Ingress | host from `ingress.host` |
| Provisioning | Job, Helm hook `post-install,post-upgrade` | `wordpress:cli`, idempotent |
| Scripts | ConfigMap | built from `files/` |
| WooCommerce MCP server | Deployment + Service + NetworkPolicy (`mcp.enabled`) | see `apps/woo-mcp/README.md` |
| `helm test` | Pod | the REST-auth check below |

## Install (local)

```bash
make up
cp .env.example .env            # fill it in
./scripts/bootstrap-secrets.sh  # creates store-db and store-wordpress
helm upgrade --install platform charts/store -n platform --create-namespace \
  -f charts/store/values-local.yaml --timeout 15m
helm test platform -n platform
```

Do not add `--wait`: the MCP server needs the Secret the hook Job writes, so Helm would wait for it before running the Job.

`--timeout 15m`: Helm waits for the hook Job to finish, and the Job downloads WooCommerce and
waits for the database. The default of 5 minutes is too short on a cold start.

Release name `platform` is what `make logs` and `make demo-reset` expect.

## Secrets

| Secret | Keys | Used by |
|---|---|---|
| `secrets.db` | `MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD` | MariaDB, WordPress, Job |
| `secrets.wpAdmin` | `WP_ADMIN_PASSWORD` | Job (first install only) |
| `secrets.mcpAuth` | `MCP_AUTH_TOKEN` | the MCP server (and the gateway, which presents it) |
| `<fullname>-mcp-bot` (written by the Job) | `username`, `password` | the WooCommerce MCP server |

For `db` and `wpAdmin`: set `existingSecret` to use a Secret you created (`bootstrap-secrets.sh`
does this, and `values-local/prod.yaml` point at its names). Leave it empty and the chart generates
random values and keeps them across upgrades using `lookup`. `lookup` returns nothing when a tool
renders without a cluster (`helm template`, some GitOps renderers), so use `existingSecret` there.
Generated Secrets carry `helm.sh/resource-policy: keep` so they outlive `helm uninstall`, like the
database volume whose password they hold.

## What the hook Job does (every install and upgrade)

Each step checks first and changes only what differs:

1. waits for `wp-config.php` on the volume and for the database
2. `wp core install` if WordPress is not installed (url from `ingress.host` + `site.scheme`)
3. pretty permalinks (`/%postname%/`)
4. WooCommerce at `woocommerce.version` (reinstalled if the version differs), then activated
5. `seed.php`: cash on delivery on, shipping off, coming-soon mode off, 4 products (once)
6. user `mcp-bot`, role `shop_manager`
7. an Application Password for that user: kept if the one in the Secret still verifies, otherwise
   replaced; the new one is written to the Secret through the Kubernetes API
   (Role: `create` secrets, `patch` on that one Secret only)

It **enforces** steps 3-6 on each run: a change made in wp-admin to those same settings is reset
by the next `helm upgrade`.

`WP_HOME` and `WP_SITEURL` are PHP constants set through `WORDPRESS_CONFIG_EXTRA`, so they always
follow the Helm values. Rows written to the database at install time are not rewritten if the host
changes later; the constants win.

## REST auth over internal HTTP

**Problem.** WordPress only accepts Application Passwords when it believes the request is HTTPS
(or `WP_ENVIRONMENT_TYPE=local`). In-cluster traffic is plain HTTP, so a correct password is
silently ignored and the API answers 401. WooCommerce consumer key/secret over HTTP has the same
limitation, so this chart uses an Application Password of a dedicated user instead.

**Approach.** The caller sends `X-Forwarded-Proto: https`. `WORDPRESS_CONFIG_EXTRA` contains a
small snippet that turns that header into `$_SERVER['HTTPS']='on'`, which makes `is_ssl()` true.

```bash
curl -u "mcp-bot:$APP_PASSWORD" -H 'X-Forwarded-Proto: https' \
  http://platform-store-wordpress/wp-json/wc/v3/products
```

**Why this is acceptable.** The Service is `ClusterIP`, so the plain-HTTP hop never leaves the
cluster. External traffic arrives through Traefik, which is expected to set `X-Forwarded-Proto`
itself and discard a value sent by the client (see "Check from outside" below).

**Alternatives not used.** `WP_ENVIRONMENT_TYPE=local` (changes more than auth); a filter that
force-enables Application Passwords (would also accept them over plain HTTP from the internet);
TLS inside the cluster (certificate management for no gain at this stage).

**Residual risks.** Anyone who can reach the Service and holds the password has `shop_manager`
rights. Traffic inside the cluster is not encrypted. NetworkPolicies (later) should restrict who can
reach `<fullname>-wordpress`.

### `helm test`

`helm test platform -n platform` runs a Pod inside the cluster that checks:

1. no credentials -> 401
2. valid Application Password, no `X-Forwarded-Proto` -> 401 (this documents the premise)
3. valid Application Password + `X-Forwarded-Proto: https` -> 200 with the seeded products

### Check from outside (not part of `helm test`)

```bash
# Must be 401: Traefik should overwrite a spoofed header, so the password is not accepted over the public http url.
curl -s -o /dev/null -w '%{http_code}\n' -u "mcp-bot:$APP_PASSWORD" -H 'X-Forwarded-Proto: https' \
  http://shop.localtest.me/wp-json/wc/v3/products
```

Get the password with:
`kubectl -n platform get secret platform-store-mcp-bot -o jsonpath='{.data.password}' | base64 -d`

## Manual checkout test

1. open http://shop.localtest.me, add a product to the cart, check out with **Cash on delivery**
2. log in at http://shop.localtest.me/wp-admin as `wpadmin` (password = `WP_ADMIN_PASSWORD` from `.env`)
3. WooCommerce -> Orders shows the order

## Known limits

- Third-party images: MariaDB runs as uid 999 (non-root). WordPress starts as root and Apache drops
  to `www-data`, so it is not `runAsNonRoot`; neither has a read-only root filesystem. Only the
  Job and the test Pod do.
- The Secret written by the Job is not owned by Helm, so `helm uninstall` leaves it behind. A reinstall
  detects the stale password and replaces it.
- `helm uninstall` removes the WordPress PVC but not the MariaDB one (StatefulSet claims survive).
  `make demo-reset` deletes both.
- The WordPress REST API is reachable publicly through the Ingress, as any WordPress site is.
