"""
Q1 private-mode LLM adapter.

Runs next to Ollama on the n8n server. Accepts the same request shapes the review
engine already sends to Gemini (generateContent) and Claude (messages), forwards
them to the local Ollama model and answers in the same shape, so the existing
n8n "Normalize" steps work unchanged. Nothing leaves the server.

No public port: only containers on the n8n Docker network can reach it.
Optional extra lock: set env Q1_LLM_TOKEN and send header x-q1-token.
"""
import os, time, hmac, logging, asyncio
import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse

TOKEN = os.environ.get("Q1_LLM_TOKEN", "")
# Backend: "ollama" (a local model) or "openai" (an OpenAI-compatible API such as Groq with Zero Data Retention)
BACKEND = os.environ.get("Q1_LLM_BACKEND", "ollama").lower()
API_BASE = os.environ.get("Q1_LLM_API_BASE", "https://api.groq.com/openai/v1").rstrip("/")
API_KEY = os.environ.get("Q1_LLM_API_KEY", "")
REASONING = os.environ.get("Q1_LLM_REASONING", "medium")  # low | medium | high (gpt-oss)
OLLAMA = os.environ.get("OLLAMA_URL", "http://q1-ollama:11434").rstrip("/")
MODEL = os.environ.get("Q1_LLM_MODEL", "qwen3:4b")
NUM_CTX = int(os.environ.get("Q1_LLM_CTX", "32768"))
MAX_PREDICT = int(os.environ.get("Q1_LLM_MAX_OUTPUT", "8192"))
SYNTH_MAX = int(os.environ.get("Q1_LLM_MAX_OUTPUT_SYNTH", str(MAX_PREDICT)))  # final report may be longer
KEEP_ALIVE = os.environ.get("Q1_LLM_KEEP_ALIVE", "15m")   # model leaves RAM after this idle time
CALL_TIMEOUT = float(os.environ.get("Q1_LLM_TIMEOUT", "5400"))  # seconds per call

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("q1-llm")  # logs sizes and timings only, never text
app = FastAPI(title="q1-llm", docs_url=None, redoc_url=None, openapi_url=None)


def check(req: Request):
    if not TOKEN:
        return
    got = req.headers.get("x-q1-token", "")
    if not hmac.compare_digest(got, TOKEN):
        raise HTTPException(status_code=401, detail="bad token")


def fit(system: str, user: str, predict: int):
    """Keep the prompt inside the context window. Trims the longest part in the middle."""
    budget_chars = int((NUM_CTX - predict - 512) * 3.2)  # ~3.2 chars/token, conservative
    note = "\n\n[... middle of the text omitted to fit the local model's context window ...]\n\n"
    total = len(system) + len(user)
    if total <= budget_chars:
        return system, user, False
    over = total - budget_chars + len(note)
    if len(system) >= len(user):
        keep = max(2000, len(system) - over)
        system = system[: int(keep * 0.75)] + note + system[-int(keep * 0.25):]
    else:
        keep = max(2000, len(user) - over)
        user = user[: int(keep * 0.75)] + note + user[-int(keep * 0.25):]
    return system, user, True


async def run(system: str, user: str, max_out: int, temperature: float, want_json: bool, cap: int = 0):
    cap = cap or MAX_PREDICT
    predict = max(256, min(int(max_out or cap), cap))
    system, user, trimmed = fit(system or "", user or "", predict + (6000 if BACKEND == "openai" else 0))
    if want_json:
        user = user + "\n\nReturn only valid JSON. No markdown, no commentary."
    if BACKEND == "openai":
        return await run_openai(system, user, predict, temperature, want_json, trimmed)
    body = {
        "model": MODEL,
        "messages": ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}],
        "stream": False,
        "think": False,
        "keep_alive": KEEP_ALIVE,
        "options": {"num_ctx": NUM_CTX, "num_predict": predict, "temperature": float(temperature if temperature is not None else 0.2)},
    }
    if want_json:
        body["format"] = "json"
    t0 = time.time()
    async with httpx.AsyncClient(timeout=CALL_TIMEOUT) as c:
        r = await c.post(f"{OLLAMA}/api/chat", json=body)
    if r.status_code != 200:
        log.info("ollama error %s", r.status_code)
        raise HTTPException(status_code=502, detail="local model error: " + r.text[:300])
    d = r.json()
    text = (d.get("message") or {}).get("content", "")
    pin, pout = d.get("prompt_eval_count", 0), d.get("eval_count", 0)
    done = d.get("done_reason", "stop")
    log.info("call ok: in=%s out=%s trimmed=%s %.0fs", pin, pout, trimmed, time.time() - t0)
    return text, pin, pout, done, trimmed


async def run_openai(system, user, predict, temperature, want_json, trimmed):
    """OpenAI-compatible chat completions (Groq). Retries politely on rate limits."""
    body = {
        "model": MODEL,
        "messages": ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}],
        # reasoning tokens share the output budget, so leave headroom for them
        "max_completion_tokens": min(predict + 6000, 65536),
        "temperature": float(temperature if temperature is not None else 0.2),
        "reasoning_effort": REASONING,
        "include_reasoning": False,
    }
    if want_json:
        body["response_format"] = {"type": "json_object"}
    headers = {"Authorization": "Bearer " + API_KEY}
    t0 = time.time()
    r = None
    async with httpx.AsyncClient(timeout=CALL_TIMEOUT) as c:
        for attempt in range(8):
            r = await c.post(f"{API_BASE}/chat/completions", json=body, headers=headers)
            if r.status_code == 400 and want_json and "json" in r.text.lower() and "response_format" in body:
                body.pop("response_format")  # model produced invalid JSON; retry once in free-text mode
                continue
            if r.status_code in (429, 500, 502, 503) and attempt < 7:
                wait = r.headers.get("retry-after")
                try:
                    wait = min(float(wait), 90.0)
                except (TypeError, ValueError):
                    wait = min(5.0 * (attempt + 1), 60.0)
                log.info("api busy %s, waiting %.0fs", r.status_code, wait)
                await asyncio.sleep(wait)
                continue
            break
    if r.status_code != 200:
        log.info("api error %s", r.status_code)
        raise HTTPException(status_code=502, detail="private model API error %s: %s" % (r.status_code, r.text[:300]))
    d = r.json()
    ch = (d.get("choices") or [{}])[0]
    text = (ch.get("message") or {}).get("content") or ""
    u = d.get("usage") or {}
    pin, pout = u.get("prompt_tokens", 0), u.get("completion_tokens", 0)
    done = "length" if ch.get("finish_reason") == "length" else "stop"
    log.info("call ok: in=%s out=%s trimmed=%s %.0fs", pin, pout, trimmed, time.time() - t0)
    return text, pin, pout, done, trimmed


@app.get("/health")
async def health():
    if BACKEND == "openai":
        try:
            async with httpx.AsyncClient(timeout=8) as c:
                r = await c.get(f"{API_BASE}/models", headers={"Authorization": "Bearer " + API_KEY})
            if r.status_code != 200:
                return JSONResponse({"ok": False, "backend": "api", "error": "API returned %s" % r.status_code}, status_code=503)
            names = [m.get("id") for m in r.json().get("data", [])]
            return {"ok": MODEL in names, "backend": "api", "model": MODEL, "num_ctx": NUM_CTX,
                    "max_output": MAX_PREDICT, "key_set": bool(API_KEY)}
        except Exception as e:
            return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=503)
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            tags = (await c.get(f"{OLLAMA}/api/tags")).json()
            ps = (await c.get(f"{OLLAMA}/api/ps")).json()
        names = [m.get("name") for m in tags.get("models", [])]
        return {"ok": MODEL in names or any(n.split(":")[0] == MODEL.split(":")[0] for n in names),
                "model": MODEL, "installed": names, "loaded": [m.get("name") for m in ps.get("models", [])],
                "num_ctx": NUM_CTX, "max_output": MAX_PREDICT}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)[:200]}, status_code=503)


@app.post("/v1beta/models/{model_action:path}")
async def gemini(model_action: str, req: Request):
    """Gemini generateContent shape in and out."""
    check(req)
    if model_action.startswith("skip"):
        # optional step switched off in private mode: answer instantly with an empty result
        return {"candidates": [{"content": {"role": "model", "parts": [{"text": "{}"}]}, "finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 0, "candidatesTokenCount": 0, "totalTokenCount": 0},
                "modelVersion": "skipped-in-private-mode", "private_mode": {"skipped": True}}
    b = await req.json()
    sys_parts = ((b.get("systemInstruction") or {}).get("parts") or [])
    system = "\n\n".join(p.get("text", "") for p in sys_parts if isinstance(p, dict))
    texts = []
    for c in b.get("contents") or []:
        for p in c.get("parts") or []:
            if "inlineData" in p or "fileData" in p:
                raise HTTPException(status_code=400, detail="Private mode cannot read images or scanned pages. Upload a PDF with a text layer, a DOCX or a TXT file.")
            if p.get("text"):
                texts.append(p["text"])
    g = b.get("generationConfig") or {}
    want_json = (g.get("responseMimeType") == "application/json") or bool(g.get("responseSchema"))
    text, pin, pout, done, trimmed = await run(system, "\n\n".join(texts), g.get("maxOutputTokens"), g.get("temperature"), want_json)
    return {
        "candidates": [{"content": {"role": "model", "parts": [{"text": text}]},
                        "finishReason": "MAX_TOKENS" if done == "length" else "STOP"}],
        "usageMetadata": {"promptTokenCount": pin, "candidatesTokenCount": pout, "totalTokenCount": pin + pout},
        "modelVersion": "local:" + MODEL,
        "private_mode": {"trimmed": trimmed},
    }


@app.post("/v1/messages")
async def anthropic(req: Request):
    """Claude messages shape in and out."""
    check(req)
    b = await req.json()
    s = b.get("system") or ""
    system = s if isinstance(s, str) else "\n\n".join(x.get("text", "") if isinstance(x, dict) else str(x) for x in s)
    texts = []
    for m in b.get("messages") or []:
        c = m.get("content")
        if isinstance(c, str):
            texts.append(c)
        else:
            for x in c or []:
                if x.get("type") == "text":
                    texts.append(x.get("text", ""))
                elif x.get("type") in ("image", "document"):
                    raise HTTPException(status_code=400, detail="Private mode cannot read images or PDFs directly.")
    user = "\n\n".join(texts)
    want_json = "json" in (system[-3000:] + user[-3000:]).lower()
    text, pin, pout, done, trimmed = await run(system, user, b.get("max_tokens"), b.get("temperature"), want_json, SYNTH_MAX)
    return {
        "id": "msg_local_%d" % int(time.time() * 1000), "type": "message", "role": "assistant",
        "model": "local:" + MODEL, "content": [{"type": "text", "text": text}],
        "stop_reason": "max_tokens" if done == "length" else "end_turn",
        "usage": {"input_tokens": pin, "output_tokens": pout},
        "private_mode": {"trimmed": trimmed},
    }


@app.post("/unload")
async def unload(req: Request):
    """Free the model's RAM now (it is reloaded automatically on the next call)."""
    check(req)
    if BACKEND == "openai":
        return {"ok": True, "unloaded": "nothing to unload (online API)"}
    async with httpx.AsyncClient(timeout=60) as c:
        await c.post(f"{OLLAMA}/api/generate", json={"model": MODEL, "keep_alive": 0})
    return {"ok": True, "unloaded": MODEL}
