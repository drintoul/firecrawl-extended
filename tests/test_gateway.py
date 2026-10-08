"""Gateway core: health, console, endpoint listing, service status, auth."""

import requests

from helpers import API_KEY, GATEWAY, req


def test_healthz(api):
    r, j = req(api, "GET", "/healthz")
    assert r.status_code == 200 and j["status"] == "ok"


def test_console_page(api):
    r, _ = req(api, "GET", "/")
    assert r.status_code == 200
    assert "text/html" in r.headers.get("content-type", "")


def test_endpoint_listing(api):
    r, j = req(api, "GET", "/api")
    assert r.status_code == 200
    for key in ("scrape", "crawl", "map", "search", "extract", "research", "interact"):
        assert j["endpoints"].get(key), f"endpoints.{key} missing"


def test_service_status(api):
    r, j = req(api, "GET", "/status", timeout=15)
    assert r.status_code == 200
    for svc in ("firecrawl", "playwright", "ollama", "searxng"):
        assert j[svc].get("status"), f"{svc} status missing"
        assert j[svc]["status"] != "down", f"{svc} is down: {j[svc].get('error', '')}"
    assert j["ollama"].get("model"), "ollama model not reported"


def test_auth_enforced_when_key_set():
    if not API_KEY:
        import pytest

        pytest.skip("no GATEWAY_API_KEY configured")
    r = requests.get(f"{GATEWAY}/api", timeout=15)
    assert r.status_code == 401, f"expected 401 without key, got {r.status_code}"
