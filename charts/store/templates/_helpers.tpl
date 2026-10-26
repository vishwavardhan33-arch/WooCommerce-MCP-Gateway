{{/*
Resource names. Release "platform" + chart "store" => "platform-store".
Truncated to 40 chars so suffixes such as "-mariadb" stay inside Kubernetes' 63-char name limit.
*/}}
{{- define "store.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}
{{- end }}

{{/*
Labels. Called as: include "store.labels" (dict "ctx" . "component" "wordpress")
app.kubernetes.io/instance is the standard label `make logs` selects on.
*/}}
{{- define "store.selectorLabels" -}}
app.kubernetes.io/name: {{ .ctx.Chart.Name }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "store.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .ctx.Chart.Name .ctx.Chart.Version }}
{{ include "store.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
{{- end }}

{{/* Names of the three Secrets. Fixed key names live in the templates that read them. */}}
{{- define "store.dbSecret" -}}
{{- default (printf "%s-db" (include "store.fullname" .)) .Values.secrets.db.existingSecret -}}
{{- end }}

{{- define "store.wpAdminSecret" -}}
{{- default (printf "%s-wp-admin" (include "store.fullname" .)) .Values.secrets.wpAdmin.existingSecret -}}
{{- end }}

{{- define "store.mcpAuthSecret" -}}
{{- default (printf "%s-woo-mcp" (include "store.fullname" .)) .Values.secrets.mcpAuth.existingSecret -}}
{{- end }}

{{- define "store.botSecret" -}}
{{- default (printf "%s-mcp-bot" (include "store.fullname" .)) .Values.mcpBot.secretName -}}
{{- end }}

{{/* The PUBLIC url of the store (what browsers and WP_HOME/WP_SITEURL use). */}}
{{- define "store.siteUrl" -}}
{{- printf "%s://%s" .Values.site.scheme .Values.ingress.host -}}
{{- end }}

{{/*
Environment shared by the WordPress Deployment AND the provisioning Job.
The Job needs it too: the image's wp-config.php reads these variables at runtime, so wp-cli
can only reach the database / know the site url if it sees the same values.
*/}}
{{- define "store.wordpressEnv" -}}
- name: WORDPRESS_DB_HOST
  value: {{ printf "%s-mariadb" (include "store.fullname" .) | quote }}
- name: WORDPRESS_DB_NAME
  value: {{ .Values.mariadb.database | quote }}
- name: WORDPRESS_DB_USER
  value: {{ .Values.mariadb.user | quote }}
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "store.dbSecret" . }}
      key: MYSQL_PASSWORD
# Extra PHP appended to wp-config.php at runtime (so a changed host takes effect on the next restart).
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', '{{ include "store.siteUrl" . }}');
    define('WP_SITEURL', '{{ include "store.siteUrl" . }}');
    define('WP_MEMORY_LIMIT', '256M');
    // In-cluster callers speak plain HTTP. WordPress only accepts Application Passwords when it
    // thinks the request is HTTPS, so we honour X-Forwarded-Proto. See README "REST auth".
    if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') {
        $_SERVER['HTTPS'] = 'on';
    }
{{- end }}
