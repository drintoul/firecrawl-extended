"""Async job endpoints: batch scrape + crawl lifecycle, status, errors, cancel."""

import pytest

from helpers import poll, req


@pytest.mark.slow
def test_batch_scrape_lifecycle(api):
    r, j = req(api, "POST", "/v2/batch/scrape", {
        "urls": ["https://example.com", "https://www.iana.org/domains/example"],
        "formats": ["markdown"],
    })
    assert r.status_code == 200 and j["success"] and j["id"], f"no job id: {j}"
    job_id = j["id"]

    job = poll(
        lambda: req(api, "GET", f"/v2/batch/scrape/{job_id}")[1],
        lambda p: p.get("status") in ("completed", "failed"),
        timeout=180,
        label="batch scrape",
    )
    assert job["status"] == "completed", f"job {job['status']}"
    assert len(job.get("data", [])) == 2, f"expected 2 docs, got {len(job.get('data', []))}"

    err_r, _ = req(api, "GET", f"/v2/batch/scrape/{job_id}/errors")
    assert err_r.status_code == 200


@pytest.mark.slow
def test_crawl_lifecycle(api):
    r, j = req(api, "POST", "/v2/crawl", {
        "url": "https://example.com",
        "limit": 2,
        "scrapeOptions": {"formats": ["markdown"]},
    })
    assert r.status_code == 200 and j["success"] and j["id"], f"no job id: {j}"
    job_id = j["id"]

    active_r, _ = req(api, "GET", "/v2/crawl/active")
    assert active_r.status_code == 200

    job = poll(
        lambda: req(api, "GET", f"/v2/crawl/{job_id}")[1],
        lambda p: p.get("status") in ("completed", "failed", "cancelled"),
        interval=4,
        timeout=90,
        label="crawl",
    )
    if job["status"] == "completed":
        assert len(job.get("data", [])) >= 1, "no crawled pages"
    else:
        # Slow crawl — exercise the cancel path instead.
        c_r, _ = req(api, "DELETE", f"/v2/crawl/{job_id}")
        assert c_r.status_code == 200

    err_r, _ = req(api, "GET", f"/v2/crawl/{job_id}/errors")
    assert err_r.status_code == 200


@pytest.mark.slow
def test_crawl_cancel(api):
    r, j = req(api, "POST", "/v2/crawl", {
        "url": "https://news.ycombinator.com",
        "limit": 25,
        "scrapeOptions": {"formats": ["markdown"]},
    })
    assert r.status_code == 200 and j["success"] and j["id"], f"no job id: {j}"
    c_r, _ = req(api, "DELETE", f"/v2/crawl/{j['id']}")
    assert c_r.status_code == 200, f"cancel failed: HTTP {c_r.status_code}"
