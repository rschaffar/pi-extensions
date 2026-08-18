# Pi Subagents Extension-Free Authentication Inheritance Plan

## Goal

Let version 3 subagent jobs use the parent session's effective runtime authentication without loading parent extensions in child processes.

Refresh inherited authentication before each later main-to-child RPC request without losing the child conversation.

## Decisions

- Keep the version 3 single-process-transport architecture from `main`.
- Keep the child model fixed to the provider and model captured by `subagent_spawn`.
- Resolve only that model provider's runtime authentication instead of transferring unrelated provider credentials.
- Leave stored and environment credentials for the child to resolve normally.
- Transfer runtime authentication, serializable provider overlays, and acknowledgements through dedicated inherited pipes.
- Keep credentials out of command arguments, the initial environment, task text, results, and logs.
- Load one internal bootstrap extension while normal extension discovery remains disabled.
- Reject executable provider overlays before launch because functions cannot cross the process boundary safely.
- Apply and acknowledge authentication before the initial RPC prompt and before every later steering request.
- Fail closed when bootstrap application or verification fails.

## Implementation

- [x] Add a bounded, validated, redaction-safe child authentication protocol.
- [x] Add parent snapshot capture and private pipe handoff with bounded acknowledgements.
- [x] Add an internal child bootstrap that installs, verifies, refreshes, restores, or fails closed provider authentication.
- [x] Thread initial and refreshed snapshots through spawn, runtime, and RPC steering paths.
- [x] Generate the bootstrap as a separate lazy child entry beside the communication bridge.
- [x] Update documentation and add a patch Changeset.
- [x] Add protocol, provider-overlay, private-transfer, refresh, process, build, and lifecycle tests.

## Verification

- [x] `npm run build --workspace @narumitw/pi-subagents` passed.
- [x] `npm run typecheck --workspace @narumitw/pi-subagents` passed.
- [x] All 73 `packages/pi-subagents/test/*.test.ts` tests passed.
- [x] Focused tests prove credentials are absent from argv, the initial environment, and the non-secret provider prelude.
- [x] A real generated-bootstrap RPC smoke proves parent runtime authentication replaces a child fallback before the first model request without loading normal extensions.
- [x] Focused tests prove parent runtime authentication refreshes before RPC steering.
- [x] The semantic audit covered child startup ordering, cancellation, acknowledgement bounds, process termination, provider restoration, fail-closed errors, generated-entry isolation, and secret-free output.
