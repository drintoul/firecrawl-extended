"""Interact service: actions, async jobs, session lifecycle + artifacts."""

import pytest

from helpers import poll, req


def test_interact_actions(api):
    r, j = req(api, "POST", "/v1/interact", {
        "url": "https://news.ycombinator.com",
        "actions": [
            {"type": "click", "target": {"getBy": "role", "role": "link", "name": "new", "exact": True},
             "waitForLoadState": "domcontentloaded"},
            {"type": "assert", "target": {"selector": "title"},
             "assertions": [{"type": "toContainText", "value": "Hacker News"}]},
            {"type": "scrape"},
        ],
        "formats": ["markdown", "links", "ariaSnapshot"],
    }, timeout=120)
    assert r.status_code == 200 and j["success"], f"HTTP {r.status_code}: {j}"
    assert len(j["data"]["markdown"]) > 100, "markdown empty"
    assert len(j.get("actionsLog", [])) >= 3, "actionsLog incomplete"
    assert len(j["data"].get("links", [])) > 5, "links missing"


def test_interact_v2_alias(api):
    """The same surface is exposed under /v2/interact."""
    r, j = req(api, "POST", "/v2/interact", {
        "url": "https://example.com",
        "actions": [{"type": "scrape"}],
        "formats": ["markdown"],
    }, timeout=120)
    assert r.status_code == 200 and j["success"], f"HTTP {r.status_code}: {j}"
    assert "documentation" in j["data"]["markdown"]


def test_interact_async_job(api):
    r, j = req(api, "POST", "/v1/interact/async", {
        "url": "https://example.com",
        "actions": [{"type": "scrape"}],
        "formats": ["markdown"],
    })
    assert r.status_code == 202 and j["id"], f"expected 202+id: {j}"

    job = poll(
        lambda: req(api, "GET", f"/v1/interact/jobs/{j['id']}")[1],
        lambda p: p.get("status") in ("completed", "failed"),
        timeout=120,
        label="interact job",
    )
    assert job["status"] == "completed", f"job {job['status']}: {job.get('error', '')}"
    assert isinstance(job.get("events"), list)
    assert "documentation" in job["data"]["markdown"]


def test_interact_session_lifecycle(api):
    r, j = req(api, "POST", "/v1/interact/sessions", {
        "url": "https://example.com", "browser": "chromium",
    })
    assert r.status_code == 200 and j["sessionId"], f"no sessionId: {j}"
    sid = j["sessionId"]
    try:
        _, listing = req(api, "GET", "/v1/interact/sessions")
        assert any(s["id"] == sid for s in listing.get("sessions", [])), "session not listed"

        ar, aj = req(api, "GET", f"/v1/interact/sessions/{sid}/artifacts/events")
        assert ar.status_code == 200 and aj["success"], f"events artifact: HTTP {ar.status_code}"

        # Reuse the session for a follow-up action.
        ur, uj = req(api, "POST", "/v1/interact", {
            "sessionId": sid,
            "actions": [{"type": "assert",
                         "assertions": [{"type": "toHaveTitle", "value": "Example Domain"}]}],
        }, timeout=60)
        assert ur.status_code == 200 and uj["success"], f"session reuse failed: {uj}"
    finally:
        dr, dj = req(api, "DELETE", f"/v1/interact/sessions/{sid}")
        assert dr.status_code == 200 and dj["success"], f"delete: HTTP {dr.status_code}"

    _, listing = req(api, "GET", "/v1/interact/sessions")
    assert not any(s["id"] == sid for s in listing.get("sessions", [])), \
        "session still listed after delete"


@pytest.mark.llm
@pytest.mark.slow
def test_interact_prompt_mode(api):
    r, j = req(api, "POST", "/v1/interact", {
        "url": "https://example.com",
        "prompt": "What is the main heading on this page? Answer with just the heading text.",
        "maxSteps": 3,
    }, timeout=480)
    assert r.status_code == 200 and j["success"], f"HTTP {r.status_code}: {j}"
    assert isinstance(j.get("answer"), str) and len(j["answer"]) > 0, "no agent answer"


def test_interact_job_not_found(api):
    r, _ = req(api, "GET", "/v1/interact/jobs/does-not-exist")
    assert r.status_code == 404, f"expected 404, got {r.status_code}"


@pytest.mark.skipif(
    __import__("os").environ.get("INTERACT_ALLOW_PRIVATE") in ("1", "true"),
    reason="private targets explicitly allowed (INTERACT_ALLOW_PRIVATE)",
)
def test_interact_blocks_private_target(api):
    """SSRF guard: interact must refuse URLs resolving to internal addresses."""
    r, j = req(api, "POST", "/v1/interact", {
        "url": "http://api:3002/",
        "actions": [{"type": "scrape"}],
        "formats": ["markdown"],
    }, timeout=60)
    assert not j.get("success"), "internal target was browsed"
    assert "private" in str(j).lower() or "insecure" in str(j).lower(), \
        f"unexpected failure mode: {j}"
