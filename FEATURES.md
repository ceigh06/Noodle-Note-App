# Noodle — Feature Status

Status legend: `not started` | `partial` | `done`

## Milestone 1: App Shell
- **Hash Routing (`/`, `/workspace`, `/workspace/study`, `/workspace/synthesizer`, `/diagnostics`)**: `done`
- **Dark Academic Theme & Bundled Local Fonts**: `done`
- **Workspace Layout & Top Bar (`/workspace`)**: `done`
- **Pillar Navigation & Category Filter Pills**: `done`
- **Mini-Notebook Floating Card**: `done`

## Milestone 2: Real File System Workspace
- **File System Access API Folder Picker & Iframe/Unsupported Fallback**: `done`
- **IndexedDB Handle Persistence & Reconnect Flow (`Dexie`)**: `done`
- **Safe Non-Empty Folder Initialization**: `done`
- **Single Storage Module (`src/storage/workspaceStorage.ts`)**: `done`
- **Canonical Note Persistence & CRUD**: `done`

## Milestone 3: Pageless TipTap Editor & Markdown Codec
- **Pageless TipTap React Editor & Fixed Google Docs-Style Toolbar**: `done` — Continuous scroll editor with Undo/Redo, Heading levels, Bold, Italic, Underline, Strike, Bullet/Ordered/Task lists, Blockquote, Code block, Link, Table, Horizontal rule, Clear formatting, and workspace Image insertion.
- **Stable Block UUIDs (`@tiptap/extension-unique-id` + `ensureBlockIds`)**: `done` — Every block-level node receives a UUID once and retains it across saves and reloads.
- **Schema Versioning, `migrateNote()`, & Canonical `contentHash`**: `done` — Ordered `v0 -> v1 -> v2` migration pipeline and SHA-256 hash over sorted-key canonical JSON.
- **Debounced Autosave (~1s) with No Autosave on Open**: `done` — `idle`/`saving`/`saved`/`error` indicator; hydration and UniqueID initialization transactions never trigger autosave.
- **Restricted Links (`http`, `https`, `mailto`) & Safe New-Tab Navigation**: `done` — Clicks never navigate the app and open allowed URLs in a new tab with `rel="noopener noreferrer"`.
- **First-Line Auto-Titling & Category Tagging**: `done`
- **Markdown Export/Import & Fidelity Docs (`docs/markdown-fidelity.md`)**: `done` — CommonMark + GFM tables and task lists; raw HTML stripped on import; imports create new notes in `manual/`.
- **Pure Plain-Text Extraction (`extractPlainText`) + Tests**: `done` — Document-order `{ blockId, text }` extraction with passing unit tests.

## Milestone 4: Workspace Image Assets (`assets/`)
- **Drag, Paste & File Picker Image Import**: `done` — Copies PNG, JPG, JPEG, GIF, and WebP images (max 10 MB, limit shown in UI; SVG disabled) into `assets/` via `workspaceStorage` and inserts workspace-relative `assets/<name>` TipTap image nodes.
- **Content-Hash Collision Handling & Byte Deduplication**: `done` — Different files with identical filenames receive unique content-hash suffixes; identical bytes reuse existing `assets/` files.
- **Blob Object URL Display & Missing-Image Placeholder**: `done` — Custom TipTap React NodeView reads files via `blob:` object URLs without exposing filesystem paths; missing assets render `Image not found: <relative path>` cleanly without crashing or triggering autosave.
- **Absolute/Traversal Path Rejection on Save**: `done` — Note saves reject any non-workspace-relative image `src` path.
- **IndexedDB Asset Tracking & Orphan Cleanup**: `done` — Dexie `noteAssets` tracks per-note asset references; deleting a note previews unreferenced `assets/` files (with first-time confirmation) and deletes only orphaned files inside `assets/` while preserving shared images.
- **Diagnostics Page (`/diagnostics`)**: `done` — Storage, Editor, Image/Asset, Change-Detection, Local Search, BYOK Cloud Privacy, and AI Output/Study Integrity self-checks implemented (30 total `PASS`/`FAIL` checks).

## Milestone 5: Reliable Change Detection
- **Workspace Folder Scanner & Index Comparison**: `done` — Recursive directory scan across `sources/`, `manual/`, and `ai/` comparing disk `(path, size, lastModified, contentHash, id)` against Dexie `notesIndex` with single-flight locking, debounce, and event-loop yielding.
- **Trigger Lifecycle (`startup`, `focus`, `30s interval`, `Rescan`)**: `done` — Runs on workspace connection, window focus / tab visibility regain, every 30 seconds while visible, and from explicit `'Rescan'` buttons in the top bar and workspace header.
- **Detect New, Edited, Deleted & Moved Notes**: `done` — `reconcileWorkspaceSnapshot` recognizes moves across folders/filenames by `note.id` (UUID) or `contentHash` fallback, preserving note identity, asset links, and index entries.
- **Ignore Own Writes**: `done` — Atomic writes and deletes record expected `contentHash`, `writtenAt`, `size`, and `lastModified` in `trackedOwnWrites`, suppressing false conflict alerts and rescan loops.
- **External Edit Conflict Banner (`Reload` / `Keep mine`)**: `done` — Pauses autosave while unresolved if the currently open note is edited outside Noodle, prompting the student to `'Reload'` from disk or `'Keep mine'` without silent overwrite.
- **Malformed/Unreadable File Tolerance & `Problems` Panel**: `done` — Invalid JSON or unreadable `.json` note files are isolated into a workspace `'Problems'` panel with path and reason instead of crashing or deleting valid index entries.
- **Batched Transactional Index Updates**: `done` — Dexie `applyBatchIndexChanges` commits bulk upserts and deletes inside a single `rw` transaction so 1,000-file scans and moves complete without freezing the UI.

## Milestone 6: Local Semantic Search, PDF/Source Extraction & Explicit Backlinks
- **On-Device Transformers.js Embeddings Worker**: `done` — `@huggingface/transformers` runs inside a Web Worker (`onnx-community/all-MiniLM-L6-v2-ONNX`, 384d) with cancellable first-use download progress, Browser Cache API offline persistence, IndexedDB model/vector metadata, and automatic re-indexing if `modelId` changes.
- **Hierarchical TipTap & Source Chunking**: `done` — Chunks TipTap blocks by H1–H3 heading path + block nodes with stable `blockId`s, alongside `.txt`/`.md` sources and `.pdf` pages extracted via `pdfjs-dist` in a Web Worker (with plain notice that `.pptx` slide formats are not supported yet).
- **Incremental Re-Indexing & Cross-Folder Semantic Search UI**: `done` — Scanner-driven incremental worker embedding updates, top-k cosine similarity computed off the main thread, honest `'semantic similarity'` vs `'word match'` fallback labels, and one-click navigation highlighting the exact block.
- **Suggested Connections & Explicit Backlinks**: `done` — Surfaces related blocks from other folders with honest similarity scores; students explicitly click **`Link`** (creating block-ID-anchored backlinks in IndexedDB) or **`Dismiss`** without any auto-linking.

## Milestone 7: Cloud LLM Synthesis (BYOK Thin Slice)
- **Key Setup Wizard (`OpenAI`, `Anthropic`, `Gemini`)**: `done` — Masked key input with show/hide toggle, direct links to each provider's API key page, explicit Gemini free-tier note, model selection, browser CORS/special-header documentation, and `'Test connection'` check directly from the browser (no proxy server).
- **Encrypted Client Key Vault & Session-Only Mode**: `done` — WebCrypto `PBKDF2` (210k SHA-256 iterations) + `AES-GCM` (256-bit) encrypted storage in IndexedDB with passphrase unlock/lock/forget, `'Keep for this session only'` memory-only option, plain UI warning that browser storage is weaker than an OS keychain, and zero key logging/export/URL/workspace-file exposure.
- **Unified Provider Adapter Interface**: `done` — Single `CloudProviderAdapter` interface implemented for Gemini (`x-goog-api-key`), OpenAI (`Authorization: Bearer`), and Anthropic (`x-api-key` + `anthropic-dangerous-direct-browser-access: true`) with secret redaction on all errors.
- **Mandatory Excerpt-Only Privacy Notice**: `done` — Appears before every single cloud call showing target provider, model, host, exact retrieved excerpts, and source notes with explicit **`Send`** and **`Cancel`** buttons backed by a single-use approval gate.
- **Synthesizer Thin Slice (`/workspace/synthesizer`)**: `done` — One-question flow that retrieves top local chunks, requires privacy-notice confirmation, sends strictly retrieved excerpts, and renders answers with clickable `[N]` citations jumping straight to cited source/note blocks (`noteId` + `blockId`).

## Milestone 8: Study Mode & Two-Pane Synthesizer
- **Study Mode (`/workspace/study`)**: `done` — Task prompt box (`"Prepare for my Calculus midterm on derivatives"`), local semantic/word-match ranking split into **Matched Source Materials (with % match)** and **Suggested Manual Notes**, and an interactive 5-step study checklist with completion persistence and direct links to source blocks, manual notes, and the Synthesizer.
- **Two-Pane Synthesizer (`My Vault` + `The Synthesis Bin`)**: `done` — Left searchable pane across `sources/`, `manual/`, and `ai/` with drag handles and click-to-add; right dashed drop zone with removable chips.
- **Output Formats & Interactive Study Views**: `done` — Supports `Study Guide`, `Summary Cheat-Sheet`, `Flashcard Set`, and `Practice Exam`; Flashcards (flip deck, hints, mastery counter) and Practice Exams (MCQ runner, score check, explanations) render interactively both immediately and inside saved `ai/` notes.
- **Retention-Biased Generation & Excerpt Sanitization**: `done` — Prompts favor the student's own phrasing, examples, and structural metaphors with explicit **`Preserved from your notes`** markers; excerpts strip scripts/HTML/markup to plain text and cap at 800 characters before showing the pre-send Privacy Notice.
- **Validated `ai/`-Only Persistence & Read-Only Backlinks**: `done` — Strictly validates provider JSON/content before writing TipTap JSON notes exclusively to `ai/` (refusing `manual/` and `sources/`) with model/provider/date/format/sources metadata, distinct visual markers, and read-only provenance backlinks resolving to real source block IDs.

## Later Milestones (Not Started)
- **Undo Log with Conflict Check**: `not started`
