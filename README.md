[中文](./README.zh-CN.md)

# Acorny Sync for SiYuan

Sync your [Acorny](https://acorny.io) highlights into SiYuan notes — one-way, incremental, and non-destructive.

Each Acorny source (article/book) maps to one SiYuan document; each highlight becomes a list block. Re-running sync is idempotent, and your own edits to synced blocks and documents are preserved.

## Features

- **One-way incremental sync** from Acorny's highlight feed via cursor pagination.
- **Native de-duplication** using block custom attributes (`custom-acorny-source-id` on the document, `custom-acorny-id` on each highlight) queried via SQL — no fragile text markers. Moving or renaming a document does not break matching.
- **Edit protection**: already-synced highlight blocks are never modified or re-appended.
- **Atomic writes**: a highlight block and its dedup attribute land in a single `appendBlock` call (inline IAL), so an interrupted sync cannot leave orphan blocks.
- **Triggers**: top-bar icon, command palette, on-startup, and optional timed polling.

## Installation

1. Build: `pnpm install && pnpm build` (produces `dist/` and `package.zip`).
2. Load the plugin in SiYuan (or install from the marketplace once published).
3. Open the plugin settings and fill in:
   - **Server URL** (default `https://api.acorny.io`)
   - **Export token** (`acornyexp_...`, from your Acorny account)
   - **Target notebook** (dropdown)
   - **Document folder** (hpath, default `/Acorny`)
   - **Sync on startup** / **Auto-sync interval (minutes)**

## Settings

| Field | Default | Notes |
|---|---|---|
| Server URL | `https://api.acorny.io` | Acorny API base |
| Export token | — | `acornyexp_...` (stored locally, password field) |
| Target notebook | — | **Where NEW source documents are created.** Already-synced sources keep their existing document wherever it lives; changing this does not migrate old documents. |
| Document folder | `/Acorny` | hpath folder for new source documents |
| Sync on startup | `true` | Sync once when the plugin loads |
| Auto-sync interval | `60` | Minutes between automatic syncs; `0` disables |

## v1 limitations

- **Append-only**: edits made on the Acorny side (note/quote) are not written back to already-synced blocks.
- **Deletions are not tracked and not auto-restored**: if you delete a synced block, incremental sync will not re-append it (the feed advances by `updatedAt`), unless that highlight is later updated in Acorny or the cursor is reset.
- **Single-instance serial idempotency**: de-duplication holds for a single running instance. Concurrent syncs from two windows/devices are not guaranteed collision-free (block attributes have no uniqueness constraint).
- The plugin is disabled in publish mode (`disabledInPublish: true`) because it relies on `query/sql`.

## Development

```bash
pnpm install
pnpm dev            # watch build
pnpm test           # vitest (pure-logic units)
pnpm typecheck      # tsc, scoped to src/ (tolerates a known siyuan SDK type quirk)
pnpm lint:check     # eslint, no auto-fix
pnpm build          # production build + package.zip
```

Architecture: pure logic (`types`/`connection`/`apiClient`/`docPath`/`renderer`/`scheduler`/`syncEngine`) is siyuan-free and unit-tested; siyuan coupling is isolated to `siyuanClient`/`httpProxy`/`siyuanGateway`/`index`.
