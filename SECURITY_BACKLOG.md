# Noodle — Security & Privacy Backlog

This log tracks temporary shortcuts or stubbed safeguards in the current milestone that must be resolved before production/feature completion.

1. **Browser Origin Boundary for Unlocked BYOK Keys**:
   - *Current state*: `KeySetupModal` and `src/cloud/keyVault.ts` encrypt keys with user passphrases via WebCrypto (`PBKDF2` + `AES-GCM` 256-bit) in IndexedDB or keep them in memory for the current session only, never write keys to logs/exports/URLs/workspace files, and disclose plainly in the UI that browser storage is weaker than an OS keychain.
   - *Remaining risk / Fix later*: Any third-party script or XSS payload executing within the same browser origin while a key is unlocked could still read key material from memory or invoke cloud endpoints. Maintain strict CSP/HTML sanitization and avoid third-party scripts; only a native desktop shell with an OS keychain provides hardware/process isolation.

2. **SVG Image Uploads Intentionally Disallowed**:
   - *Current state*: Allowed image types are strictly `png`, `jpg`, `jpeg`, `gif`, and `webp` (max 10 MB). `.svg` and `image/svg+xml` are blocked at import.
   - *Fix later*: If SVG support is added in a future milestone, sanitize SVGs (strip `<script>`, event handlers, foreignObject, and external refs) and render via isolated `<img>` / sandboxed context only.

3. **Block-Level Conflict Undo Log**:
   - *Current state*: TipTap provides in-session ProseMirror undo/redo; cross-session undo log with file `contentHash` conflict checks is deferred.
   - *Fix later*: Implement Dexie undo log verifying target file hash before reverting any move/edit.

*Resolved in Milestone 3*:
- Restricted editor and Markdown-imported links strictly to `http:`, `https:`, and `mailto:` protocols, opening links in a new tab with `rel="noopener noreferrer"` and preventing in-app navigation.
- Stripped raw HTML tags, HTML comments, and `<script>`/`<style>` blocks during Markdown import (`stripRawHtml`) without raw HTML injection.
- Added canonical sorted-key SHA-256 `contentHash` computation (`computeCanonicalContentHash`) and ordered `migrateNote()` schema migrations.

*Resolved in Milestone 4*:
- Enforced strictly workspace-relative `assets/<name>` paths on all image nodes, rejecting absolute, URL, or traversal paths on save (`validateNoteAssetPaths`), Markdown import, and asset reads.
- Displayed images solely via `blob:` object URLs read through `workspaceStorage.ts` without exposing local filesystem paths.
- Scoped orphan asset cleanup strictly to `assets/` with IndexedDB reference tracking and explicit first-time deletion confirmation listing affected files.

*Resolved in Milestone 5*:
- Prevented silent overwrites when an open note is modified outside Noodle by halting debounced autosave and requiring an explicit `'Reload'` or `'Keep mine'` decision.
- Recomputed canonical SHA-256 `contentHash` on uncached disk reads during scanning and sanitized nested relative pillar paths segment-by-segment via `sanitizeName()`.
- Isolated malformed/unreadable JSON files into the `'Problems'` panel without crashing or executing arbitrary file content.

*Resolved in Milestone 6*:
- Kept all note/source text, embeddings, cosine similarity, and PDF parsing strictly on-device inside Web Workers (`embeddingWorker.ts`, `pdfWorker.ts`) with zero user note text sent off-device.
- Never wrote to `sources/` during `.pdf`, `.txt`, and `.md` extraction, and surfaced an explicit non-destructive notice that `.pptx` slide decks are not supported yet.
- Kept suggested connections strictly opt-in (`Link` / `Dismiss`) with zero silent auto-linking.

*Resolved in Milestone 7*:
- Implemented BYOK API key management with WebCrypto (`PBKDF2` SHA-256 + `AES-GCM` 256-bit) IndexedDB storage and a `'Keep for this session only'` memory-only mode, strictly keeping keys out of logs, exports, URLs, and workspace files.
- Enforced a single-use approval gate and mandatory pre-flight privacy notice (`CloudPrivacyNoticeModal`) before every single cloud call showing provider, model/host, and exact retrieved excerpts + source notes (strict `'Send only retrieved excerpts'` rule).
- Added secret redaction (`redactSecretFromText`) across all provider error paths and diagnostic self-checks verifying key redaction, encryption round-trips, wrong-passphrase rejection, and notice gating.

*Resolved in Milestone 8*:
- Sanitized all retrieved excerpts to plain text (stripping scripts, styles, HTML tags, dangerous URI schemes, and Markdown URLs) and enforced an explicit 800-character cap per excerpt prior to displaying the Privacy Notice modal.
- Validated structured cloud provider responses (schema fields, exam option/answer bounds, and absence of unsafe script/XSS markup) before any file or IndexedDB write occurs, rejecting malformed outputs cleanly with zero writes.
- Enforced `ai/`-only persistence (`saveAiSynthesizedNote` and `validateAndPersistAiSynthesisResult`) refusing writes to `manual/` or `sources/`, paired with read-only provenance backlinks verified against real source block IDs.
