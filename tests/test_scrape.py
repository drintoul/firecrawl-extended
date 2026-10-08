"""Scrape / map / search endpoints (proxied to the upstream Firecrawl api)."""

import pytest

from helpers import req


def test_v1_scrape_markdown_and_links(api):
    r, j = req(api, "POST", "/v1/scrape", {
        "url": "https://example.com",
        "formats": ["markdown", "links"],
        "onlyMainContent": True,
    })
    assert r.status_code == 200 and j["success"], f"HTTP {r.status_code}: {j}"
    # example.com has no <h1> — the title lives in metadata.
    assert j["data"]["metadata"]["title"] == "Example Domain"
    assert "documentation" in j["data"]["markdown"]
    assert isinstance(j["data"]["links"], list)


def test_v2_scrape_markdown(api):
    r, j = req(api, "POST", "/v2/scrape", {
        "url": "https://example.com",
        "formats": ["markdown", "links"],
    })
    assert r.status_code == 200 and j["success"], f"HTTP {r.status_code}: {j}"
    assert "documentation" in j["data"]["markdown"]


@pytest.mark.llm
def test_v2_scrape_json_format(api):
    r, j = req(api, "POST", "/v2/scrape", {
        "url": "https://example.com",
        "formats": [
            "markdown",
            {
                "type": "json",
                "prompt": "Extract the page title and the first paragraph.",
                "schema": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "firstParagraph": {"type": "string"},
                    },
                },
            },
        ],
    }, timeout=300)
    assert r.status_code == 200 and j["success"], f"HTTP {r.status_code}: {j}"
    assert isinstance(j["data"].get("json"), dict), "json format output missing"


def test_v2_search(api):
    r, j = req(api, "POST", "/v2/search", {"query": "firecrawl web scraping", "limit": 3})
    assert r.status_code == 200 and j["success"], f"HTTP {r.status_code}: {j}"
    web = j["data"].get("web", [])
    assert web and web[0].get("url"), "no web results"


def test_v2_map(api):
    r, j = req(api, "POST", "/v2/map", {"url": "https://news.ycombinator.com", "limit": 10})
    assert r.status_code == 200 and j.get("success") is not False, f"HTTP {r.status_code}: {j}"
    assert len(j.get("links", [])) > 0, "no links discovered"
