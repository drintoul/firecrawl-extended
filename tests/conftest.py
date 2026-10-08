import time

import pytest
import requests

from helpers import API_KEY, GATEWAY


@pytest.fixture(scope="session")
def api():
    """requests.Session pre-authenticated against the gateway."""
    s = requests.Session()
    if API_KEY:
        s.headers["Authorization"] = f"Bearer {API_KEY}"
    return s


@pytest.fixture(scope="session", autouse=True)
def gateway_ready(api):
    """Block the whole suite until the gateway answers /healthz."""
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            if api.get(f"{GATEWAY}/healthz", timeout=5).status_code == 200:
                return
        except requests.RequestException:
            pass
        time.sleep(3)
    pytest.exit(f"gateway at {GATEWAY} did not become healthy within 180s")
