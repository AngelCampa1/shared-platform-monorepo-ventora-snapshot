# Reusable BFF route template — FastAPI.
#
# Mints HMAC client-assertion headers and proxies AI assistant calls to the deployed
# Worker. The assertion secret stays server-side. There is no Python assistant-contracts
# package, so the signing primitive is reimplemented here, byte-for-byte compatible with
# `buildHmacPayload` / `signHmacPayload` in `@ventora/ai-assistant-contracts`.
#
# Defaults to AI-SDR; see the AI-CS notes inline.
#
# Required env:
#   AI_SDR_WORKER_URL               e.g. https://ventora-ai-sdr-worker.example-account.workers.dev
#   AI_SDR_CLIENT_ASSERTION_SECRET  HMAC secret shared with the Worker
# For AI-CS, swap to AI_CS_WORKER_URL / AI_CS_CLIENT_ASSERTION_SECRET.

import os
import json
import uuid
import hmac
import hashlib
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

router = APIRouter()

WORKER_URL = os.environ["AI_SDR_WORKER_URL"]
ASSERTION_SECRET = os.environ["AI_SDR_CLIENT_ASSERTION_SECRET"]


def _stable_json(value) -> str:
    # Mirror TS stableJson: recursively sorted keys, compact separators.
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _build_hmac_payload(timestamp: str, nonce: str, method: str, path: str, body) -> str:
    body_hash = hashlib.sha256(_stable_json(body).encode()).hexdigest()
    return f"{timestamp}.{nonce}.{method.upper()}.{path}.{body_hash}"


def _sign(payload: str, secret: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


async def _proxy(client: httpx.AsyncClient, path: str, body, origin: str | None = None) -> httpx.Response:
    """Sign `body` for `path` and forward to the Worker. Send the exact signed bytes."""
    ts = datetime.now(timezone.utc).isoformat()
    nonce = str(uuid.uuid4())
    payload = _build_hmac_payload(ts, nonce, "POST", path, body)
    headers = {
        "content-type": "application/json",
        "X-Ventora-Timestamp": ts,
        "X-Ventora-Nonce": nonce,
        "X-Ventora-Signature": _sign(payload, ASSERTION_SECRET),
    }
    # AI-CS only: forward the original browser origin.
    if origin:
        headers["Origin"] = origin
    return await client.post(f"{WORKER_URL}{path}", content=_stable_json(body), headers=headers)


@router.post("/api/ai-sdr/sessions")
async def create_session(req: Request):
    # AI-CS: authenticate the product user first, then inject user_id into body.
    body = await req.json()
    async with httpx.AsyncClient() as client:
        res = await _proxy(client, "/v1/sessions", body, req.headers.get("origin"))
    return JSONResponse(content=res.json(), status_code=res.status_code)


@router.post("/api/ai-sdr/chat")
async def chat(req: Request):
    body = await req.json()

    async def stream():
        async with httpx.AsyncClient(timeout=None) as client:
            ts = datetime.now(timezone.utc).isoformat()
            nonce = str(uuid.uuid4())
            payload = _build_hmac_payload(ts, nonce, "POST", "/v1/chat", body)
            headers = {
                "content-type": "application/json",
                "X-Ventora-Timestamp": ts,
                "X-Ventora-Nonce": nonce,
                "X-Ventora-Signature": _sign(payload, ASSERTION_SECRET),
            }
            async with client.stream(
                "POST", f"{WORKER_URL}/v1/chat", content=_stable_json(body), headers=headers
            ) as res:
                async for chunk in res.aiter_bytes():
                    yield chunk

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.post("/api/ai-sdr/handoff")
async def handoff(req: Request):
    body = await req.json()
    # 1. Persist the lead FIRST — durable source of truth, independent of the Worker.
    #    await leads.insert(source="ai-sdr", **body)
    # 2. Optionally notify CRM / founder / on-call here.
    # For AI-CS: change "/v1/handoff" -> "/v1/escalations" and open a support ticket.
    async with httpx.AsyncClient() as client:
        res = await _proxy(client, "/v1/handoff", body, req.headers.get("origin"))
    return JSONResponse(content={"ok": True, "worker_status": res.status_code}, status_code=202)
