# Changelog

All notable changes to this extension are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-09-22

### Added

- Author credit linking to Maverick Li's blog in the README and extension settings.

## [1.0.0] - 2026-09-16

Initial release.

### Added

- Page and block suggestions as you type, without typing `[[` first. Pick a page to
  insert `[[Title]]` (or `#tag`), or a block to insert `((uid))` (or
  `[text](((uid)))`). Picking a block never creates a new page.
- Support for Chinese, Japanese, and Korean input. Nothing pops up while the IME is
  composing; matching starts once the text is committed. Since these languages have no
  spaces between words, the extension looks back from the cursor for the longest ending
  that matches a page title.
- A preview pane for the selected suggestion: for a page, its block count, linked
  reference count and outline; for a block, the page it lives on, its text and its
  children. Up to 28 blocks, 4 levels deep, with `[[links]]`, `#tags`,
  `((references))`, bold, italic, highlights, code and TODO / DONE checkboxes rendered.
- Theme matching. Colors are measured from whatever theme is active — Roam's own light
  and dark mode, Roam Studio, or a custom `roam/css` theme — and checked for contrast
  before use, falling back to a built-in palette when a theme can't be read. Pages are
  shown in the theme's page-link color and blocks in the normal text color.
- Suggestions stay out of Roam's way: nothing pops up inside `[[ ]]`, `(( ))`, `{{ }}`,
  `#tag`, `/commands`, `attribute::` or code blocks, or while Roam's own autocomplete
  is open.
- Eleven settings under Settings → Inline Autocomplete, covering minimum characters,
  lookback length, result counts, delay, daily-notes filtering, and the insert format
  for both pages and blocks.
- Three command palette entries: **Inline Autocomplete: Toggle**, **Refresh page
  titles**, and **Refresh theme colors**.
