"""
Q1 private-mode LLM adapter.

Runs next to Ollama on the n8n server. Accepts the same request shapes the review
engine already sends to Gemini (generateContent) and Claude (messages), forwards
them to the local Ollama model and answers in the same shape, so the existing
n8n "Normalize" steps work unchanged. Nothing leaves the server.

No public port: only containers on the n8n Docker network can reach it.
Optional extra lock: set env Q1_LLM_TOKEN and send header x-q1-token.
"""
import os, time, hmac, logging
import httpx
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse

TOKEN = os.environ.get("Q1_LLM_TOKEN", "")
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
    system, user, trimmed = fit(system or "", user or "", predict)
    if want_json:
        user = user + "\n\nReturn only valid JSON. No markdown, no commentary."
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


@app.get("/health")
async def health():
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
    async with httpx.AsyncClient(timeout=60) as c:
        await c.post(f"{OLLAMA}/api/generate", json={"model": MODEL, "keep_alive": 0})
    return {"ok": True, "unloaded": MODEL}
