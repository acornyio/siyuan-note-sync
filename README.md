[中文](./README.zh-CN.md)

# Acorny Sync for SiYuan

Sync your [Acorny](https://acorny.io) highlights into SiYuan notes — one-way, incremental, and non-destructive.

Each Acorny source (article/book) maps to one SiYuan document; each highlight becomes a list block. Re-running sync is idempotent, and your own edits to synced blocks and documents are preserved.

## Features

- **One-way reconciling sync**: every sync reads your full Acorny highlight feed and makes SiYuan match it — new highlights are added, and anything you deleted in SiYuan is rebuilt.
- **Native de-duplication** using block custom attributes (`custom-acorny-source-id` on the document, `custom-acorny-id` on each highlight) queried via SQL — no fragile text markers. Moving or renaming a document does not break matching, and already-synced highlights are skipped (no duplicates).
- **Edit protection**: already-synced highlight blocks are never modified or re-appended.
- **Atomic writes**: a highlight block and its dedup attribute land in a single `appendBlock` call (inline IAL), so an interrupted sync cannot leave orphan blocks.
- **Triggers**: top-bar icon, command palette, on-startup, and optional timed polling.

## Installation

1. Install **Acorny Sync** from SiYuan's marketplace (Settings → Marketplace → Plugins), or build from source: `pnpm install && pnpm build` (produces `dist/` and `package.zip`).
2. Enable the plugin.
3. Open the plugin settings and fill in:
   - **Export token** (`acornyexp_...`, from your Acorny account)
   - **Target notebook** (dropdown)
   - **Document folder** (hpath, default `/Acorny`)
   - **Sync on startup** / **Auto-sync interval (minutes)**
4. Check the "Documents will be written to: <notebook> → <folder>" line below the settings, then press **"Save and sync now"**.

> ⚠️ **The first sync must be started by you.** Until you have run one yourself, sync on startup,
> interval sync and save-triggered sync **do not run at all** — the notebook and folder both have
> defaults, and without this gate "paste a token and hit save" would already write into a
> destination you never confirmed. Users upgrading from an older version also need to press it once.
>
> To go back to the un-initialised state, use the "Reset setup" button in Settings (uninstalling a
> plugin in SiYuan does **not** delete its data, so "delete and reinstall" won't reset it).

## Settings

| Field | Default | Notes |
|---|---|---|
| Export token | — | `acornyexp_...` (stored locally, password field) |
| Target notebook | — | The notebook highlights are written into. **Changing it migrates already-synced documents there** (see below). |
| Document folder | `/Acorny` | hpath folder inside the notebook. **Changing it also migrates existing documents.** |
| Sync on startup | `true` | Sync once when the plugin loads. **Only takes effect after initial setup** (see Installation). |
| Auto-sync interval | `60` | Minutes between automatic syncs; `0` disables. Also only after initial setup. |

### About migration

When the target notebook or document folder changes, the next sync moves existing Acorny documents to the new location:

- only documents carrying the Acorny anchor attribute are moved — **your own documents are never touched**;
- moves use `moveDocsByID`, so **document ids stay the same** and highlights, block attributes and backlinks are preserved;
- documents you deleted are not resurrected by a migration;
- this is **continuous reconciliation**, not a one-shot action: whenever the setting and the actual location disagree, the next sync corrects it.

If you want to move some documents elsewhere and have them stay there, that conflicts with how this plugin works — it will move them back on the next sync.

## v1 limitations

- **Append-only for edits**: edits made on the Acorny side (note/quote) are not written back to already-synced highlight blocks. (Deletions in SiYuan, however, are rebuilt on the next sync — see Features.)
- **Full-feed reconciliation**: each sync reads the entire feed rather than resuming from a cursor. This is what lets deletions self-heal, at the cost of re-reading the full feed every sync; for a personal highlight library that is cheap (dedup skips existing blocks).
- **The first sync must be triggered manually**: a deliberate safety gate, see Installation.
- **Single-instance serial idempotency**: de-duplication holds for a single running instance. Concurrent syncs from two windows/devices are not guaranteed collision-free (block attributes have no uniqueness constraint).
- The plugin is disabled in publish mode (`disabledInPublish: true`) because it relies on `query/sql`.

## Privacy & security

- **One-way and non-destructive**: the plugin only reads from Acorny and writes into SiYuan. It never sends your notes back to Acorny.
- **Your export token is stored locally** in this plugin's SiYuan data (`data.json`) in plain text — the same as every SiYuan plugin, since the kernel offers no secure-storage API. Anyone with access to your workspace files can read it. Treat it like a password, and revoke it from your Acorny account if it leaks.
- **The token is only ever sent to `https://api.acorny.io`**, as an `Authorization` header, over the SiYuan kernel's network proxy.
- **No third parties**: the plugin talks only to your Acorny server and your local SiYuan kernel. It bundles no telemetry or analytics.

## Development

> 🧭 **Before touching the sync / dedup / migration logic, read [`docs/SIYUAN_KERNEL_CONTRACT.md`](./docs/SIYUAN_KERNEL_CONTRACT.md).**
> It lists kernel behaviours verified against a real kernel — several are counter-intuitive, and
> every incident this project has had traces back to one of them.

```bash
pnpm install
pnpm dev            # watch build
pnpm test           # vitest (pure-logic units)
pnpm typecheck      # tsc, scoped to src/ (tolerates a known siyuan SDK type quirk)
pnpm lint:check     # eslint, no auto-fix
pnpm build          # production build + package.zip
```

Architecture: pure logic (`types`/`apiClient`/`docPath`/`renderer`/`scheduler`/`syncEngine`) is siyuan-free and unit-tested; siyuan coupling is isolated to `siyuanClient`/`httpProxy`/`siyuanGateway`/`index`.
