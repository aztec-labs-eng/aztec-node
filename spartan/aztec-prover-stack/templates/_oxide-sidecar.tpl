{{- define "prover.oxideSidecar.validate" -}}
{{- $r := .Values.node.oxideSidecar -}}
{{- if $r.enabled -}}
{{- if or (ne .Values.nodeType "prover-node") (ne (int .Values.replicaCount) 1) (not .Values.statefulSet.enabled) -}}
{{- fail "oxideSidecar requires a singleton prover-node StatefulSet" -}}
{{- end -}}
{{- $hasClaim := false -}}
{{- range .Values.statefulSet.volumeClaimTemplates -}}
{{- if eq .metadata.name "data" -}}{{- $hasClaim = true -}}{{- end -}}
{{- end -}}
{{- if not (and .Values.persistence.enabled (or .Values.persistence.existingClaim $hasClaim)) -}}
{{- fail "oxideSidecar requires persistent data storage (existingClaim or data volumeClaimTemplate)" -}}
{{- end -}}
{{- range $key := list "image" "manifestUrl" "portal" "proofSubmissionTarget" -}}
{{- if not (get $r $key) -}}{{- fail (printf "oxideSidecar.%s is required" $key) -}}{{- end -}}
{{- end -}}
{{- if not (regexMatch "(:[^/:]+|@sha256:[a-f0-9]{64})$" $r.image) -}}
{{- fail "oxideSidecar.image must specify a tag or sha256 digest" -}}
{{- end -}}
{{- range $key := list "portal" "proofSubmissionTarget" -}}
{{- if or (not (regexMatch "^0x[0-9a-fA-F]{40}$" (get $r $key))) (eq (get $r $key) "0x0000000000000000000000000000000000000000") -}}
{{- fail (printf "oxideSidecar.%s must be a nonzero Ethereum address" $key) -}}
{{- end -}}
{{- end -}}
{{- range $key := list "provingCostPerCheckpoint" "minProfit" "minProfitMarginBps" -}}
{{- if not (regexMatch "^[0-9]+$" (toString (get $r $key))) -}}
{{- fail (printf "oxideSidecar.%s requires an explicit nonnegative integer (use quoted strings)" $key) -}}
{{- end -}}
{{- end -}}
{{- if le (int $r.startupTimeoutSeconds) 0 -}}{{- fail "oxideSidecar.startupTimeoutSeconds must be positive" -}}{{- end -}}
{{- if or (not .Values.node.disableAdminApiKey) .Values.node.adminApiKeyHash -}}
{{- fail "oxideSidecar requires disabled prover admin authentication" -}}
{{- end -}}
{{- if not .Values.node.configMap.envEnabled -}}
{{- fail "oxideSidecar requires node.configMap.envEnabled for proof-submission settings" -}}
{{- end -}}
{{- if not (and .Values.node.secret.envEnabled .Values.node.secret.mnemonic) -}}
{{- fail "oxideSidecar requires node.secret.envEnabled and node.secret.mnemonic for init-container identity derivation" -}}
{{- end -}}
{{- if not (or (hasKey .Values.node.env "KEY_INDEX_START") (hasKey .Values.node.secret "mnemonicIndex")) -}}
{{- fail "oxideSidecar requires an identity mnemonic index" -}}
{{- end -}}
{{- if not .Values.global.l1ExecutionUrls -}}
{{- fail "oxideSidecar requires global.l1ExecutionUrls" -}}
{{- end -}}
{{- $env := mergeOverwrite (dict) .Values.global.aztecEnv .Values.node.env -}}
{{- range $key := list "PROVER_NODE_PROOF_SUBMISSION_TARGET_ADDRESS" "PROVER_NODE_DISABLE_PROOF_PUBLISH" "AZTEC_ADMIN_API_KEY_HASH" "AZTEC_DISABLE_ADMIN_API_KEY" -}}
{{- if hasKey $env $key -}}{{- fail (printf "oxideSidecar: configure %s through chart settings, not node.env/global.aztecEnv" $key) -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "prover.oxideSidecar.container" -}}
{{- $r := .Values.node.oxideSidecar -}}
{{- if $r.enabled }}
{{- include "prover.oxideSidecar.validate" . }}
- name: oxide-relayer
  image: {{ $r.image | quote }}
  args: ["run"]
  env:
    - name: NODE_OPTIONS
      value: "--import=/oxide-startup/wait.mjs"
    - name: OXIDE_STARTUP_TIMEOUT_SECONDS
      value: {{ $r.startupTimeoutSeconds | quote }}
    - name: OXIDE_RELAYER_MODES
      value: "epoch-proofs"
    - name: OXIDE_RELAYER_SIGNER
      value: "env"
    - name: OXIDE_DEPLOYMENT_ENV_MANIFEST_URL
      value: {{ $r.manifestUrl | quote }}
    - name: OXIDE_PORTAL
      value: {{ $r.portal | quote }}
    - name: AZTEC_NODE_URL
      value: {{ printf "http://127.0.0.1:%v" .Values.service.rpc.port | quote }}
    - name: OXIDE_RELAYER_PROVER_NODE_URL
      value: {{ printf "http://127.0.0.1:%v" .Values.service.admin.port | quote }}
    - name: OXIDE_RELAYER_STATE_PATH
      value: {{ printf "/data/oxide-relayer/oxide-relayer-%s.sqlite3" $r.portal | quote }}
    - name: OXIDE_RELAYER_EARLY_PROOF_PROVING_COST_PER_CHECKPOINT
      value: {{ $r.provingCostPerCheckpoint | quote }}
    - name: OXIDE_RELAYER_EARLY_PROOF_MIN_PROFIT
      value: {{ $r.minProfit | quote }}
    - name: OXIDE_RELAYER_EARLY_PROOF_MIN_PROFIT_MARGIN_BPS
      value: {{ $r.minProfitMarginBps | quote }}
    - name: READ_L1_RPC_URL
      valueFrom:
        secretKeyRef:
          name: {{ include "chart.fullname" . }}-oxide-rpc
          key: READ_L1_RPC_URL
  volumeMounts:
    - name: oxide-identity
      mountPath: /oxide-identity
      readOnly: true
    - name: data
      mountPath: /data
    - name: oxide-startup
      mountPath: /oxide-startup
      readOnly: true
  resources:
    {{- toYaml $r.resources | nindent 4 }}
{{- end -}}
{{- end -}}

{{- define "prover.oxideSidecar.initContainer" -}}
{{- if .Values.node.oxideSidecar.enabled }}
- name: derive-prover-identity
  image: {{ printf "%s:%s" (.Values.node.image.repository | default .Values.global.aztecImage.repository) (.Values.node.image.tag | default .Values.global.aztecImage.tag) | quote }}
  imagePullPolicy: {{ .Values.global.aztecImage.pullPolicy }}
  command: ["/bin/bash", "/oxide-startup/derive-prover-identity.sh"]
  env:
    - name: MNEMONIC
      valueFrom:
        secretKeyRef:
          name: {{ include "chart.fullname" . }}-env
          key: MNEMONIC
    - name: KEY_INDEX_START
      value: {{ ternary .Values.node.env.KEY_INDEX_START .Values.node.secret.mnemonicIndex (hasKey .Values.node.env "KEY_INDEX_START") | quote }}
  volumeMounts:
    - name: oxide-startup
      mountPath: /oxide-startup
      readOnly: true
    - name: shared
      mountPath: /shared
    - name: oxide-identity
      mountPath: /oxide-identity
{{- end }}
{{- end -}}

{{- define "prover.oxideSidecar.volumes" -}}
{{- if .Values.node.oxideSidecar.enabled }}
- name: oxide-identity
  emptyDir:
    medium: Memory
- name: oxide-startup
  configMap:
    name: {{ include "chart.fullname" . }}-oxide-startup
{{- end }}
{{- end -}}
