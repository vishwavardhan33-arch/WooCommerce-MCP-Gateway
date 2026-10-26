{{/*
Resource names. This chart is installed as its OWN release, "platform-apps" (the store chart already owns
the release name "platform"). Release "platform-apps" + chart "platform" => "platform-apps"; the components
add a suffix ("platform-apps-mcp-fx"). Truncated to 40 chars so suffixes stay inside Kubernetes' 63-char name limit.
*/}}
{{- define "platform.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}
{{- end }}

{{/*
Labels. Called as: include "platform.labels" (dict "ctx" . "component" "mcp-fx")
app.kubernetes.io/instance is the standard label `make logs` selects on.
*/}}
{{- define "platform.selectorLabels" -}}
app.kubernetes.io/name: {{ .ctx.Chart.Name }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "platform.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .ctx.Chart.Name .ctx.Chart.Version }}
{{ include "platform.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
{{- end }}

{{/* Names of the Secrets holding each MCP server's bearer token (key: MCP_AUTH_TOKEN). */}}
{{- define "platform.mcpFxSecret" -}}
{{- default (printf "%s-mcp-fx" (include "platform.fullname" .)) .Values.secrets.mcpFx.existingSecret -}}
{{- end }}

{{- define "platform.mcpNotesSecret" -}}
{{- default (printf "%s-mcp-notes" (include "platform.fullname" .)) .Values.secrets.mcpNotes.existingSecret -}}
{{- end }}
