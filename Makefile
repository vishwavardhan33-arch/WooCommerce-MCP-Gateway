# Local developer workflow. Everything here targets the k3d cluster, never your other kube contexts.
CLUSTER     ?= woo-mcp
NAMESPACE   ?= platform
RELEASE     ?= platform
BASE_DOMAIN ?= localtest.me
# Where the gateway answers (dashboard host; /api and /mcp are routed to the gateway by the Ingress).
SMOKE_BASE_URL ?= http://app.$(BASE_DOMAIN)

# Always pass --context explicitly so a mistake can't touch a different cluster.
CONTEXT := k3d-$(CLUSTER)
KUBECTL := kubectl --context $(CONTEXT)

.PHONY: up down smoke smoke-cluster demo-reset logs

# Create an EMPTY cluster and wait until Traefik is ready to route.
up:
	@for t in docker k3d kubectl helm; do command -v $$t >/dev/null || { echo "missing tool: $$t"; exit 1; }; done
	@if k3d cluster list $(CLUSTER) >/dev/null 2>&1; then \
	    echo "cluster '$(CLUSTER)' already exists"; \
	else \
	    k3d cluster create --config deploy/k3d.yaml; \
	fi
	@$(KUBECTL) wait --for=condition=Ready node --all --timeout=120s
	@echo "waiting for Traefik..."
	@for i in $$(seq 1 60); do $(KUBECTL) -n kube-system get deploy traefik >/dev/null 2>&1 && break; sleep 2; done
	@$(KUBECTL) -n kube-system rollout status deploy/traefik --timeout=120s
	@echo ""
	@echo "Cluster '$(CLUSTER)' is ready (kube context: $(CONTEXT))."
	@echo "Nothing is deployed yet. Once deployed, the URLs will be"
	@echo "(*.$(BASE_DOMAIN) resolves to 127.0.0.1, so no /etc/hosts edits):"
	@echo "  Storefront  http://shop.$(BASE_DOMAIN)"
	@echo "  WP admin    http://shop.$(BASE_DOMAIN)/wp-admin"
	@echo "  Dashboard   http://app.$(BASE_DOMAIN)"
	@echo "  MCP gateway http://app.$(BASE_DOMAIN)/mcp"
	@echo "Next: cp .env.example .env, fill it in, then ./scripts/bootstrap-secrets.sh"

# Delete the whole cluster (and with it every volume).
down:
	k3d cluster delete $(CLUSTER)

# Is the cluster alive and is Traefik answering on host port 80?
# We send the Host header ourselves, so this works without any DNS.
smoke-cluster:
	@$(KUBECTL) get nodes
	@code=$$(curl -s -o /dev/null -w '%{http_code}' -H "Host: shop.$(BASE_DOMAIN)" http://127.0.0.1/ || true); \
	if [ "$$code" = "000" ]; then \
	    echo "FAIL: nothing answers on http://127.0.0.1:80 (is the cluster up? is port 80 free?)"; exit 1; \
	fi; \
	echo "ok: Traefik answered HTTP $$code (404 is expected until the store is deployed)"

# The cluster check above, then the full end-to-end story (scripts/smoke-test.ts): users and keys, an
# MCP client, revocation, disabling a server, scaling an upstream to 0, and the audit log. Needs the
# whole platform deployed and the shop, fx and notes servers registered in the gateway.
# .env is loaded for ADMIN_BOOTSTRAP_PASSWORD; the script exits 1 if any check fails.
smoke: smoke-cluster
	@command -v npx >/dev/null || { echo "missing tool: npx (Node 20+ and 'npm install' are needed)"; exit 1; }
	@set -a; [ ! -f .env ] || . ./.env; set +a; \
	SMOKE_BASE_URL="$(SMOKE_BASE_URL)" SMOKE_NAMESPACE="$(NAMESPACE)" SMOKE_KUBE_CONTEXT="$(CONTEXT)" \
	npx tsx scripts/smoke-test.ts

# Back to a fresh store and fresh gateway data, but keep the cluster and the Secrets.
# Uninstalling the release does not delete PVCs created by StatefulSets, so we delete them too.
demo-reset:
	@if helm --kube-context $(CONTEXT) status $(RELEASE) -n $(NAMESPACE) >/dev/null 2>&1; then \
	    helm --kube-context $(CONTEXT) uninstall $(RELEASE) -n $(NAMESPACE); \
	else \
	    echo "no release '$(RELEASE)' installed"; \
	fi
	@if $(KUBECTL) get namespace $(NAMESPACE) >/dev/null 2>&1; then \
	    $(KUBECTL) -n $(NAMESPACE) delete pvc --all; \
	else \
	    echo "namespace '$(NAMESPACE)' does not exist, nothing to wipe"; \
	fi
	@echo "Reset done. Re-install the chart to get a fresh store."

# Follow logs of every pod in the release. app.kubernetes.io/instance is the standard label Helm charts set.
logs:
	@$(KUBECTL) -n $(NAMESPACE) logs -f -l app.kubernetes.io/instance=$(RELEASE) \
	    --all-containers --prefix --tail=50 --max-log-requests=20
