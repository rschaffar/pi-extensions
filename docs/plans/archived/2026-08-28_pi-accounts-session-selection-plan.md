# Pi Accounts Recent Session Selection Plan

## Goal

Keep the session-local account-selection architecture from `main`.

Let a genuinely new Pi session start from the newest usable account selection in the same project without storing or copying credentials.

## Decisions

- Keep session-ID-owned custom entries as the source of truth.
- Keep concurrent sessions isolated inside one Pi process.
- Do not mirror selections through process-global environment variables.
- Restore an owned snapshot before considering recent-session inheritance.
- Run recent discovery only for a new session or startup without an existing session file.
- Exclude the current file and reject sessions from another project directory.
- Scan candidates newest first and use the newest valid owned snapshot.
- Preserve valid unknown provider IDs and fill missing managed providers from compatibility defaults.
- Store only provider IDs, account aliases, and explicit default markers.
- Bound startup time, metadata candidate count, concurrency, state reads, individual file size, total bytes, and lifecycle cancellation.
- Fail closed when candidate files contain matching invalid selection state and no valid candidate is usable.

## Implementation

- [x] Add bounded recent-session discovery to `session-selection.ts`.
- [x] Reuse the current session-ID schema and strict parser for discovered snapshots.
- [x] Wire discovery before initial provider synchronization and persist a new owner-specific snapshot.
- [x] Keep resume, reload, fork, clone, and `/tree` behavior on the current `main` architecture.
- [x] Update the account README and the existing minor Changeset.
- [x] Add focused discovery, project isolation, current-file exclusion, invalid-candidate, cancellation, and lifecycle integration tests.

## Verification

- [x] `npm run build --workspace @narumitw/pi-accounts` passed.
- [x] `npm run typecheck --workspace @narumitw/pi-accounts` passed.
- [x] All 112 `packages/pi-accounts/test/*.test.ts` tests passed.
- [x] The semantic audit covered session replacement, cancellation after asynchronous reads, current-file exclusion, project matching, race-detected file reads, strict non-secret parsing, compatibility fallback, and owner-specific publication.
