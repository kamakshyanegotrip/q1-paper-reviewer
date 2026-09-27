#!/usr/bin/env bash
# Q1 private mode with the AI model on ANOTHER computer (e.g. your PC running Ollama),
# reached privately over Tailscale. Only the small q1-llm adapter runs on this server.
# Usage:  bash deploy-remote.sh <tailscale-ip-of-your-pc> [model] [context] [max-answer-tokens]
#   e.g.  bash deploy-remote.sh 100.101.102.103 qwen3:4b 24576 2000
# A smaller max-answer-tokens makes each step faster on a slow PC (the final report gets 2x).
set -e
cd "$(dirname "$0")"
PC_IP="$1"; MODEL="${2:-qwen3:8b}"; CTX="${3:-32768}"; MAXOUT="${4:-2000}"
if [ -z "$PC_IP" ]; then echo "Usage: bash deploy-remote.sh <tailscale-ip-of-your-pc> [model] [context]"; exit 1; fi
command -v tailscale >/dev/null || { echo "ERROR: Tailscale is not installed on this server yet (see the setup steps)."; exit 1; }
echo "Checking that this server can reach Ollama on your PC at $PC_IP ..."
if ! curl -s -m 8 "http://$PC_IP:11434/api/tags" > /tmp/q1-tags.json; then
  echo "ERROR: cannot reach http://$PC_IP:11434 - is the PC on, Tailscale connected on both, Ollama running with OLLAMA_HOST=0.0.0.0, and the firewall rule added?"; exit 1; fi
grep -q "\"$MODEL\"" /tmp/q1-tags.json || echo "WARNING: model $MODEL is not downloaded on the PC yet (run: ollama pull $MODEL)"
N8N=$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /n8n/ {print $1; exit}')
[ -z "$N8N" ] && { echo "ERROR: no running n8n container found."; exit 1; }
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$N8N" | awk '{print $1}')
docker build -t q1-llm .
docker rm -f q1-llm >/dev/null 2>&1 || true
docker run -d --name q1-llm --restart unless-stopped --network "$NET" --memory 256m \
  -e OLLAMA_URL="http://$PC_IP:11434" -e Q1_LLM_MODEL="$MODEL" -e Q1_LLM_CTX="$CTX" -e Q1_LLM_MAX_OUTPUT="$MAXOUT" -e Q1_LLM_MAX_OUTPUT_SYNTH="$((MAXOUT*2))" q1-llm
echo "Waiting for the adapter to start..."; sleep 6
docker exec "$N8N" node -e "fetch('http://q1-llm:8001/health').then(r=>r.text()).then(t=>console.log('Health check from n8n: '+t)).catch(e=>{console.log('Health check failed: '+e.message);process.exit(1)})" && echo "OK - n8n can reach the model on your PC."
echo "Done. Tell Claude the line starting with 'Health check from n8n'."
