# Release Engineering

jean-ci publishes container images to GHCR with two channels:

## Channels

### Development channel
- Trigger: every push to `main`
- Tag: `ghcr.io/telegraphic-dev/jean-ci:dev`
- Purpose: latest mainline build for internal testing / fast iteration

### Stable channel
- Trigger: git tag matching `v*.*.*`
- Tags:
  - `vX.Y.Z`
  - `X.Y`
  - `X`
  - `latest`
- Purpose: versioned OSS releases

## Security / supply-chain outputs

Each published image includes:
- **SBOM** via Docker Buildx (`sbom: true`)
- **provenance** via Docker Buildx (`provenance: mode=max`)
- **GitHub artifact attestation** via `actions/attest-build-provenance`
- **cosign keyless signature** on the pushed image digest

## Release process

### Publish dev image
Push to `main`:

```bash
git push origin main
```

That publishes/updates:

```text
ghcr.io/telegraphic-dev/jean-ci:dev
```

### Publish stable release
1. Update version if needed
2. Tag the release:

```bash
git tag v0.14.0
git push origin v0.14.0
```

This publishes:
- `ghcr.io/telegraphic-dev/jean-ci:v0.14.0`
- `ghcr.io/telegraphic-dev/jean-ci:0.14`
- `ghcr.io/telegraphic-dev/jean-ci:0`
- `ghcr.io/telegraphic-dev/jean-ci:latest`

It also creates a GitHub Release with the image digest and release notes.

## Public-package / final-switch runbook

The repository is already public, but package consumers should still treat this as the controlled release checklist:

1. Confirm CI green on `main`
2. Confirm security scans green
3. Confirm `dev` image published successfully
4. Create semver tag
5. Verify GHCR tags, signature, SBOM, and provenance exist
6. Verify GitHub Release body contains image digest
7. Announce stable tag / update docs if needed

## Notes
- `latest` is reserved for stable semver tags only
- `dev` always tracks `main`
- If a signing/provenance step fails, treat the release as incomplete even if the image pushed
