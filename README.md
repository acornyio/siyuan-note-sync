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

1. Install **Acorny Sync** from SiYuan's marketplace (Settings → Marketplace → Plugins), or build from source: `pnpm install && pnpm build` (produces `dist/` and `package.zip`).
2. Enable the plugin.
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
- **Single-block deletions are not tracked**: if you delete an individual synced block, incremental sync will not re-append it (the feed advances by `updatedAt`), unless that highlight is later updated in Acorny. **A full wipe self-heals**: if a saved cursor exists but no `custom-acorny-id` is found (all docs deleted), sync automatically drops the cursor and rebuilds. To force a rebuild after a partial delete, use the **"Full re-sync"** command.
- **Single-instance serial idempotency**: de-duplication holds for a single running instance. Concurrent syncs from two windows/devices are not guaranteed collision-free (block attributes have no uniqueness constraint).
- The plugin is disabled in publish mode (`disabledInPublish: true`) because it relies on `query/sql`.

## Privacy & security

- **One-way and non-destructive**: the plugin only reads from Acorny and writes into SiYuan. It never sends your notes back to Acorny.
- **Your export token is stored locally** in this plugin's SiYuan data (`data.json`) in plain text — the same as every SiYuan plugin, since the kernel offers no secure-storage API. Anyone with access to your workspace files can read it. Treat it like a password, and revoke it from your Acorny account if it leaks.
- **The token is only ever sent to your configured Server URL**, as an `Authorization` header, over the SiYuan kernel's network proxy. Keep the default `https://` endpoint; an `http://` URL would transmit the token in clear text.
- **No third parties**: the plugin talks only to your Acorny server and your local SiYuan kernel. It bundles no telemetry or analytics.

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
