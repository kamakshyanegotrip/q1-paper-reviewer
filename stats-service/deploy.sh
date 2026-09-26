#!/usr/bin/env bash
# Q1 stats service - one-command install on the n8n server (needs Docker).
# Builds the image, joins the n8n Docker network, creates a private token and runs the container.
# No public port is opened: only n8n can reach it, at http://q1-stats:8000
set -e
cd "$(dirname "$0")"
N8N=$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /n8n/ {print $1; exit}')
if [ -z "$N8N" ]; then echo "ERROR: no running n8n container found (docker ps)."; exit 1; fi
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$N8N" | awk '{print $1}')
echo "n8n container: $N8N   network: $NET"
if [ ! -s .q1-stats-token ]; then
  (openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n') > .q1-stats-token
fi
chmod 600 .q1-stats-token
docker build -t q1-stats .
docker rm -f q1-stats >/dev/null 2>&1 || true
if [ "$NET" = "host" ]; then
  docker run -d --name q1-stats --restart unless-stopped -p 127.0.0.1:8000:8000 -e Q1_STATS_TOKEN="$(cat .q1-stats-token)" q1-stats
  echo "NOTE: n8n uses host networking - in n8n the URL must be http://127.0.0.1:8000/analyze"
else
  docker run -d --name q1-stats --restart unless-stopped --network "$NET" -e Q1_STATS_TOKEN="$(cat .q1-stats-token)" q1-stats
fi
echo "Waiting for the service to start..."; sleep 8
if docker exec "$N8N" node -e "fetch('http://q1-stats:8000/health').then(r=>r.text()).then(t=>{console.log('Health check from n8n: '+t)}).catch(e=>{console.log('Health check failed: '+e.message);process.exit(1)})"; then
  echo "OK - n8n can reach the stats service."
fi
echo
echo "================ COPY THIS TOKEN INTO n8n (not into chat) ================"
cat .q1-stats-token; echo
echo "=========================================================================="
