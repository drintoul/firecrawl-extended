# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately — do **not** open a public issue.

- Preferred: [GitHub private vulnerability reporting](https://github.com/drintoul/firecrawl-extended/security/advisories/new)
  (if disabled on the repo, email instead)
- Email: **drintoul@gmail.com**

Include a description, affected commit/branch, reproduction steps or runtime
evidence, and impact. Expect an acknowledgement within a few days.

## Scope notes

This project is a self-hosted scraping/browser stack — several features are
powerful by design and only safe behind authentication:

- `playwright-service` and `interact` drive real browsers to arbitrary URLs.
  Interact refuses targets that resolve to private/internal addresses by
  default (`INTERACT_ALLOW_PRIVATE=1` opts out). SSRF to internal services is
  therefore a **bug**; "can navigate to public sites" is the feature.
- The gateway is the trust boundary. Deployments **must** set
  `GATEWAY_API_KEY`, or explicitly opt out with `ALLOW_UNAUTHENTICATED=true`
  for trusted-local use. Unauthenticated deployments are a misconfiguration,
  not a supported mode.

## Hardening baseline

- Bind `playwright-service` to localhost (`PLAYWRIGHT_BIND=127.0.0.1`); it has
  no auth of its own.
- Keep `api` unpublished — reachable only through the gateway.
- Rotate `GATEWAY_API_KEY` if it may have been exposed.
