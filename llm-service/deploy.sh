#!/usr/bin/env bash
# Q1 private mode - installs a local AI model (Ollama) and the q1-llm adapter on the n8n server.
# No public port is opened: only n8n can reach it, at http://q1-llm:8001
# Usage:  bash deploy.sh            (picks the model from free memory)
#         MODEL=qwen3:4b bash deploy.sh   (force a model)
set -e
cd "$(dirname "$0")"
N8N=$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /n8n/ {print $1; exit}')
if [ -z "$N8N" ]; then echo "ERROR: no running n8n container found (docker ps)."; exit 1; fi
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$N8N" | awk '{print $1}')
CORES=$(nproc)
AVAIL_GB=$(awk '/MemAvailable/ {printf "%d", $2/1048576}' /proc/meminfo)
DISK_GB=$(df -BG --output=avail /var/lib/docker 2>/dev/null | tail -1 | tr -dc 0-9)
echo "n8n container: $N8N  network: $NET  cores: $CORES  free RAM: ${AVAIL_GB} GB  free disk: ${DISK_GB} GB"

# Model choice: leave at least 2 GB of RAM for n8n and the stats service.
#   >= 14 GB free: qwen3:8b, 40k context   |  8-13 GB: qwen3:4b, 40k context  |  6-7 GB: qwen3:4b, 24k context
if [ -z "$MODEL" ]; then
  if   [ "$AVAIL_GB" -ge 14 ]; then MODEL=qwen3:8b; MEM=11g; CTX=${CTX:-40960}
  elif [ "$AVAIL_GB" -ge 8 ];  then MODEL=qwen3:4b; MEM=7g;  CTX=${CTX:-40960}
  elif [ "$AVAIL_GB" -ge 6 ];  then MODEL=qwen3:4b; MEM=$((AVAIL_GB-2))g; CTX=${CTX:-24576}
  else echo "ERROR: only ${AVAIL_GB} GB RAM free - private mode needs at least 6 GB free. Nothing was installed."; exit 1; fi
else
  MEM=${MEM:-$((AVAIL_GB-2))g}; CTX=${CTX:-32768}
fi
if [ "${DISK_GB:-99}" -lt 8 ]; then echo "ERROR: less than 8 GB free disk. Nothing was installed."; exit 1; fi
# Keep one core free for n8n.
CPUS=$(( CORES > 1 ? CORES - 1 : 1 ))
echo "Model: $MODEL   memory limit: $MEM   CPU limit: $CPUS   context: $CTX tokens"

NETARG="--network $NET"; OLLAMA_URL=http://q1-ollama:11434; PORTARG=""
if [ "$NET" = "host" ]; then NETARG=""; OLLAMA_URL=http://127.0.0.1:11434; PORTARG="-p 127.0.0.1:8001:8001"; OPORT="-p 127.0.0.1:11434:11434"; fi

docker pull ollama/ollama:latest
docker rm -f q1-ollama >/dev/null 2>&1 || true
docker run -d --name q1-ollama --restart unless-stopped $NETARG $OPORT \
  --memory "$MEM" --cpus "$CPUS" -v q1-ollama-models:/root/.ollama \
  -e OLLAMA_NUM_PARALLEL=1 -e OLLAMA_MAX_LOADED_MODELS=1 -e OLLAMA_KEEP_ALIVE=15m \
  -e OLLAMA_FLASH_ATTENTION=1 -e OLLAMA_KV_CACHE_TYPE=q8_0 \
  ollama/ollama:latest
sleep 5
echo "Downloading $MODEL (a few GB, one time)..."
docker exec q1-ollama ollama pull "$MODEL"

docker build -t q1-llm .
docker rm -f q1-llm >/dev/null 2>&1 || true
docker run -d --name q1-llm --restart unless-stopped $NETARG $PORTARG \
  -e OLLAMA_URL="$OLLAMA_URL" -e Q1_LLM_MODEL="$MODEL" -e Q1_LLM_CTX="$CTX" \
  q1-llm
echo "Waiting for the adapter to start..."; sleep 6
HOST=q1-llm; if [ "$NET" = "host" ]; then HOST=127.0.0.1; fi
docker exec "$N8N" node -e "fetch('http://$HOST:8001/health').then(r=>r.text()).then(t=>console.log('Health check from n8n: '+t)).catch(e=>{console.log('Health check failed: '+e.message);process.exit(1)})" && echo "OK - n8n can reach the local model."
if [ "$NET" = "host" ]; then echo "NOTE: n8n uses host networking - tell Claude, the URL must be http://127.0.0.1:8001"; fi
echo
echo "Done. Private mode is ready: tick 'Private mode' on the website to use it."
echo "Memory used now: $(docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' q1-ollama q1-llm | tr '\n' ' ')"
