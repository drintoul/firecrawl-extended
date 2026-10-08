"""LLM-backed endpoints: /v1/extract shim and /v1/research composer."""

import pytest

from helpers import req


@pytest.mark.llm
def test_v1_extract(api):
    r, j = req(api, "POST", "/v1/extract", {
        "urls": ["https://example.com"],
        "prompt": "Extract the page title and main heading.",
        "schema": {
            "type": "object",
            "properties": {"title": {"type": "string"}, "heading": {"type": "string"}},
        },
    }, timeout=300)
    assert r.status_code == 200 and j["success"], f"HTTP {r.status_code}: {j}"
    assert isinstance(j.get("data"), dict), "no extracted data"


@pytest.mark.llm
@pytest.mark.slow
def test_v1_research_compound_query(api):
    r, j = req(api, "POST", "/v1/research", {
        "query": "Which airlines fly nonstop from Abbotsford (YXX), and name one boutique hotel in Victoria BC?",
        "limit": 5,
    }, timeout=600)
    assert r.status_code == 200 and j["success"], f"HTTP {r.status_code}: {j}"
    assert isinstance(j.get("answer"), str) and len(j["answer"]) > 20, "answer missing/thin"
    assert isinstance(j.get("queries"), list) and len(j["queries"]) >= 2, \
        f"expected decomposed queries, got {j.get('queries')}"
    assert 1 <= j["rounds"] <= 2, f"rounds={j.get('rounds')}"
    assert isinstance(j.get("sources"), list)
    assert len(j.get("documents", [])) > 0


def test_v1_research_requires_query(api):
    r, _ = req(api, "POST", "/v1/research", {"limit": 2})
    assert r.status_code == 400, f"expected 400, got {r.status_code}"
