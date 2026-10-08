"""Shared HTTP helpers for the API test suite.

Env: GATEWAY (default http://localhost:18080), MCP (default
http://localhost:18081/mcp), GATEWAY_API_KEY (sent as bearer if set).
"""

import json
import os
import time

import requests

GATEWAY = os.environ.get("GATEWAY", "http://localhost:18080").rstrip("/")
MCP = os.environ.get("MCP", "http://localhost:18081/mcp").rstrip("/")
API_KEY = os.environ.get("GATEWAY_API_KEY", "")

DEFAULT_TIMEOUT = 120


def req(api, method, path, body=None, timeout=DEFAULT_TIMEOUT, base=GATEWAY):
    """JSON request against the gateway. Returns (response, parsed_json)."""
    kwargs = {"timeout": timeout}
    if body is not None:
        kwargs["json"] = body
    r = api.request(method, f"{base}{path}", **kwargs)
    try:
        return r, r.json()
    except ValueError:
        return r, {"raw": r.text}


def poll(fn, done, interval=3.0, timeout=120.0, label="poll"):
    """Call fn() until done(result) — raises TimeoutError on expiry."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if done(last):
            return last
        time.sleep(interval)
    raise TimeoutError(f"{label}: timed out after {timeout}s (last={last})")


def mcp_rpc(method, params=None, timeout=180):
    """JSON-RPC over Streamable HTTP; accepts plain JSON or SSE responses."""
    r = requests.post(
        MCP,
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
        headers={
            "Accept": "application/json, text/event-stream",
            **({"Authorization": f"Bearer {API_KEY}"} if API_KEY else {}),
        },
        timeout=timeout,
    )
    r.raise_for_status()
    if "event-stream" in r.headers.get("content-type", ""):
        # Decode bytes as UTF-8 ourselves — requests guesses ISO-8859-1 for
        # text/* types, which mangles multi-byte chars into \x85 NELs that
        # str.splitlines() would wrongly split on.
        body = r.content.decode("utf-8", errors="replace")
        # Events are blank-line-separated; a payload may span several data: lines.
        for block in body.split("\n\n"):
            data = "\n".join(
                line[5:].lstrip() for line in block.split("\n") if line.startswith("data:")
            )
            if not data:
                continue
            msg = json.loads(data)
            if msg.get("id") == 1:
                return msg
        raise AssertionError("MCP: no JSON-RPC response in SSE stream")
    return r.json()
