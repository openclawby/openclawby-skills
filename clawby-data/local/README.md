# local/ — never touched by updates

Everything in this directory is preserved across skill updates (it is in the
`keep_local` list). Use it for local state, caches, and references to secrets.

- **Force an update** regardless of the 24h timer: create an empty file named
  `force-update` here. The update protocol deletes it after a successful run.
- **Secrets** (API keys, wallet keys) belong in environment variables, not in files.
