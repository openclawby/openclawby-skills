# local/ — never touched by updates

Everything in this directory is preserved across skill updates (it is in the
`keep_local` list). Use it for local state, caches, and references to secrets.

- **Force a version re-check** regardless of the 24h timer: delete
  `<skill>/manifest.json` (`../manifest.json` from this folder). The next time the
  skill is used it re-checks the remote version and ASKS the user before
  updating — see `update-protocol.md`.
- **Secrets** (API keys, wallet keys) belong in environment variables, not in files.
