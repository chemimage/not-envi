# Release conventions

- GitHub release titles must exactly match the version tag, for example
  `v1.10.0`. Do not prepend `Hyve` or other descriptive text. Preserve existing
  release-title formatting when updating releases.
- Keep commit subjects natural. Put version-bump annotations in the commit
  body as `+semver: patch`, `+semver: minor`, `+semver: major`, or
  `+semver: none`; do not require `feat:` or `fix:` subject prefixes.
