#!/usr/bin/env bash
# Removes private mode completely and frees its disk space (model files) and memory.
docker rm -f q1-llm q1-ollama 2>/dev/null
docker volume rm q1-ollama-models 2>/dev/null
docker image rm q1-llm ollama/ollama:latest 2>/dev/null
echo "Private mode removed. Run deploy.sh again to reinstall."
