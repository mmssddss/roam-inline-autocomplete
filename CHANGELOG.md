# Changelog

All notable changes to this extension are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-05

### Added

- **Block search delay (ms)** setting (default 250). Block suggestions are searched once
  you pause typing and added below the page suggestions without moving the selection;
  page suggestions still show up on every keystroke.
- **Minimum characters for blocks (other text)** setting (default 4) for text without
  Chinese, Japanese, or Korean characters.

### Changed

- Block search is much lighter on large graphs: at most one search per pause instead of
  up to two per keystroke, and as a word grows (mach → machi) the previous results are
  narrowed down right away instead of searching the graph again.
- When only blocks matched and the popup opens after you pause, Enter and Tab go to Roam
  for its first 200 ms, so a newline you were already typing isn't taken over.
- **Minimum characters for blocks** now applies to text with Chinese, Japanese, or
  Korean characters; other text uses the new setting above.
- ← / → / Home / End move the cursor as usual and close the suggestions, so a
  following Enter is Roam's own newline.

### Fixed

- Enter / Tab could replace the wrong text after the cursor was moved while
  suggestions were open, or when Enter was pressed before a delayed match caught up.
  Now nothing is replaced if the text before the cursor no longer matches, and the key
  works as usual (Enter inserts a newline instead of being swallowed).

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
