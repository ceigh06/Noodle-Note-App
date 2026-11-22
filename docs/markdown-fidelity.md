# Markdown Fidelity & Round-Trip Notes

Noodle's canonical storage format is **TipTap JSON** (`.json` files inside `manual/`, `ai/`, and `sources/`). Markdown import/export supports **CommonMark** plus **GFM tables** and **task lists**.

## Supported Round-Trip Elements
- Headings (`H1`–`H3` on import, `H1`–`H6` on export)
- Paragraphs and soft/hard breaks
- Inline marks: **bold**, *italic*, ~~strikethrough~~, `inline code`, and `[links](url)` restricted to `http`, `https`, and `mailto`
- Bullet lists, ordered lists, nested lists, and task lists (`- [ ]` / `- [x]`)
- Blockquotes (`>`)
- Fenced code blocks (```` ``` ````)
- Horizontal rules (`---`)
- GFM pipe tables (`| col | col |`)
- Workspace-relative image blocks (`![alt](assets/...)`)

## What Does NOT Round-Trip
1. **Stable Block UUIDs (`attrs.id`)**: Markdown has no standard per-block UUID attribute. Exporting to Markdown drops block IDs; re-importing assigns fresh UUIDs to each imported block.
2. **Underline Marks (`<u>` / underline)**: CommonMark has no native underline syntax. Underlined text is exported as plain text without underline formatting.
3. **Table Cell Formatting & Sizing**: Column widths (`colwidth`), cell merges (`colspan`/`rowspan`), and multi-paragraph cells are flattened into single-line GFM table cells on export.
4. **Raw HTML**: Raw HTML tags, `<script>`/`<style>` blocks, and HTML comments are stripped on import for safety and do not enter TipTap JSON.
5. **Unsafe Link Protocols & Non-Relative Images**: Links with disallowed schemes (such as `javascript:` or `data:`) are stripped down to plain label text on import and omitted on export. External or absolute image paths (e.g., `/abs/path.png`, `https://...`) are rejected on import and omitted on export; only workspace-relative `assets/<name>` paths are permitted.
6. **Note Envelope Metadata**: Fields outside `content` (`id`, `schemaVersion`, `category`, `pillar`, `createdAt`, `updatedAt`, `contentHash`) belong to the JSON note envelope and are not embedded as frontmatter in exported `.md` files.
7. **Whitespace & List Styles**: Tight vs. loose list spacing and alternate bullet markers (`*`, `+`) normalize to `-` on export.
