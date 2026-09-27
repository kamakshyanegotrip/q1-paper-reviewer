#!/usr/bin/env bash
# Q1 private mode using Groq (gpt-oss-120b) with Zero Data Retention switched on in your Groq account.
# Only the small q1-llm adapter runs on this server. Your Groq key is typed here (hidden),
# saved in /root/.q1-llm.env (readable by root only) and never shown or sent anywhere else.
# Usage:  bash deploy-groq.sh            (asks for the key the first time)
#         bash deploy-groq.sh --new-key  (replace the saved key)
set -e
cd "$(dirname "$0")"
ENVF=/root/.q1-llm.env
MODEL="${Q1_MODEL:-openai/gpt-oss-120b}"
if [ ! -s "$ENVF" ] || [ "$1" = "--new-key" ]; then
  echo "Paste your Groq API key and press Enter (nothing will show while you paste):"
  read -r -s KEY; echo
  KEY="$(echo -n "$KEY" | tr -d '[:space:]')"
  case "$KEY" in gsk_*) ;; *) echo "ERROR: that does not look like a Groq key (it should start with gsk_)."; exit 1;; esac
  umask 077
  printf 'Q1_LLM_API_KEY=%s\n' "$KEY" > "$ENVF"
  chmod 600 "$ENVF"; unset KEY
  echo "Key saved to $ENVF (root only)."
fi
echo "Checking the key with Groq ..."
umask 077; HDR=$(mktemp)
printf 'Authorization: Bearer %s\n' "$(sed -n 's/^Q1_LLM_API_KEY=//p' "$ENVF")" > "$HDR"
CODE=$(curl -s -o /tmp/q1-models.json -w '%{http_code}' -H @"$HDR" https://api.groq.com/openai/v1/models || true)
rm -f "$HDR"
if [ "$CODE" != "200" ]; then echo "ERROR: Groq answered $CODE - check the key (run: bash deploy-groq.sh --new-key)."; exit 1; fi
grep -q "\"$MODEL\"" /tmp/q1-models.json || echo "WARNING: $MODEL is not listed for your account."
rm -f /tmp/q1-models.json
N8N=$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /n8n/ {print $1; exit}')
[ -z "$N8N" ] && { echo "ERROR: no running n8n container found."; exit 1; }
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$N8N" | awk '{print $1}')
docker build -q -t q1-llm . >/dev/null
docker rm -f q1-llm >/dev/null 2>&1 || true
docker run -d --name q1-llm --restart unless-stopped --network "$NET" --memory 256m \
  --env-file "$ENVF" -e Q1_LLM_BACKEND=openai -e Q1_LLM_MODEL="$MODEL" \
  -e Q1_LLM_CTX=131072 -e Q1_LLM_MAX_OUTPUT=16000 -e Q1_LLM_MAX_OUTPUT_SYNTH=32000 \
  -e Q1_LLM_REASONING=medium -e Q1_LLM_TIMEOUT=900 q1-llm >/dev/null
echo "Waiting for the adapter to start..."; sleep 5
docker exec "$N8N" node -e "fetch('http://q1-llm:8001/health').then(r=>r.text()).then(t=>console.log('Health check from n8n: '+t)).catch(e=>{console.log('Health check failed: '+e.message);process.exit(1)})" && echo "OK - private mode now uses Groq."
echo "Done. Tell Claude the line starting with 'Health check from n8n'."
