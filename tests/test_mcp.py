"""MCP interface: tools/list + tools/call over Streamable HTTP."""

import json

import pytest
import requests

from helpers import API_KEY, MCP, mcp_rpc


def test_anonymous_mcp_rejected():
    """When GATEWAY_API_KEY is configured, /mcp must refuse anonymous calls."""
    if not API_KEY:
        pytest.skip("no GATEWAY_API_KEY configured")
    r = requests.post(
        MCP,
        json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        headers={"Accept": "application/json, text/event-stream"},
        timeout=15,
    )
    assert r.status_code == 401, f"anonymous MCP call returned {r.status_code}"


def test_tools_list():
    msg = mcp_rpc("tools/list")
    tools = msg["result"]["tools"]
    assert len(tools) >= 14, f"expected >=14 tools, got {len(tools)}"
    names = {t["name"] for t in tools}
    for name in ("firecrawl_scrape", "firecrawl_search", "firecrawl_research",
                 "firecrawl_interact", "firecrawl_interact_async", "firecrawl_extract"):
        assert name in names, f"tool {name} missing"


def test_tools_call_scrape():
    msg = mcp_rpc("tools/call", {
        "name": "firecrawl_scrape",
        "arguments": {"url": "https://example.com", "formats": ["markdown"]},
    })
    text = msg["result"]["content"][0]["text"]
    payload = json.loads(text)
    assert "documentation" in payload["data"]["markdown"], "MCP scrape returned no markdown"
