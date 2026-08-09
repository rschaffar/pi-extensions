# @narumitw/pi-sync

## 0.49.8

### Patch Changes

- f75f7e9: Open reviewed synced-content recovery when automatic or interactive TUI sync detects a content-list mismatch, preserve deferred attention in the manager and editor, and keep deterministic and non-TUI routes non-blocking.

## 0.49.7

### Patch Changes

- 549e626: Resolve differing local and remote synced-content lists inline with reviewed adoption, explicit continuation, and the existing safe force-push path.

## 0.49.6

### Patch Changes

- fa9c938: Reduce idle startup imports by loading Goal presentation, Chat networking and UI, and Sync operation-specific modules only when their routes require them.

## 0.49.5

### Patch Changes

- 8289ba9: Move operational state from `.pisync` to `pi-sync` with an explicit guarded migration and fail-closed path handling.
- Updated dependencies [736ca9e]
  - @narumitw/pi-tui-kit@0.52.0

## 0.49.4

### Patch Changes

- 6432b4d: Make included-content intent portable across snapshots, add reviewed remote-policy adoption, pause sync on explicit policy divergence, and allow safe custom paths that exist only remotely.
