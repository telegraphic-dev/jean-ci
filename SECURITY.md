# Security Policy

## Supported Versions

Until `v1.0.0`, only the latest `main` branch and the latest pre-release tag are supported.
After `v1.0.0`, the latest minor in each active major version is supported.

## Reporting a Vulnerability

Please **do not open a public GitHub issue** for vulnerabilities.

Report privately by:
- opening a GitHub Security Advisory draft in this repository, or
- emailing the maintainers (to be added before public launch)

Include:
- affected component/version
- reproduction steps
- impact assessment
- suggested mitigation (if available)

We target:
- **Acknowledgement:** within 48 hours
- **Initial triage:** within 5 business days
- **Fix or mitigation plan:** as soon as severity is confirmed

## Secret Handling

- Never commit credentials, tokens, private keys, or webhook secrets.
- Use environment variables and secret stores only.
- Any leaked secret must be rotated immediately, even if removed from git history.

## Pre-Public OSS Gate

This repository stays private until OSS readiness issue #66 is complete, including:
- history + HEAD secret scans
- secret rotation verification
- hardened setup docs
- release signing/SBOM pipeline
