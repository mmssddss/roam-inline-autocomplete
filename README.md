# Inline Autocomplete for Roam Research

Page and block suggestions pop up as you type, without typing `[[` first. Works with Chinese, Japanese, and Korean input methods.

## Install (local developer extension)

1. Put the `roam-inline-autocomplete` folder anywhere on your computer.
2. In Roam, open Settings → Roam Depot and turn on **Enable developer mode** (the ⚙ in the top-right corner).
3. Under Developer Extensions, click **Load extension** and choose this folder.
4. After editing `extension.js`, click **Reload** in the same place.

## Usage

| Key | What it does |
|---|---|
| Type as usual | When the text before the cursor matches a page title, suggestions appear |
| ↑ / ↓ | Move through the suggestions |
| Enter / Tab | Page: replaces the matched text with `[[Title]]` (or `#tag`). Block: replaces it with `((uid))` (or `[text](((uid)))`) |
| Esc | Close the suggestions. They won't reappear for the same word until you type a different word or move to another block |

To stay out of the way of Roam's own autocomplete, nothing pops up inside `[[ ]]`, `(( ))`, `{{ }}`, `#tag`, `/commands`, `attribute::`, or ``` code blocks.

## Suggestions

Each suggestion is shown the way Roam writes it:

- **Pages** look like the link you'll get: `[[Title]]`, or `#Title` if you insert tags.
- **Blocks** have a bullet, with the page they're on underneath. Picking one inserts a block reference; it **never** creates a new page.

Pages come first, then blocks, with a divider in between. Block search is on by default, starts at 3 characters, and shows up to 5 blocks. You can change these or turn it off in the settings.

## Preview

The popup has two panes: suggestions on the left and a live preview of the selected one on the right (switch with ↑ / ↓ or by hovering). Key hints run along the bottom.

- Page: the title, how many blocks it has and how many linked references point to it, and an outline of the page.
- Block: the page it's on, the block's text, and its children.

The preview is read-only. It lightly styles `[[links]]`, `#tags`, `((references))` (shown as the referenced block's text), bold, italic, highlights, and code, and shows up to 28 blocks, 4 levels deep. In windows narrower than 640px, only the list is shown.

## Appearance

The popup follows Roam's light and dark mode automatically. If you use the [Roam Studio](https://github.com/rcvd/RoamStudio) plugin, it also matches whichever theme (Craft, Things, Quattro, and so on) and appearance (Light / Dark / Auto) is active — colors, shadows, and corner radius included. No setup needed.

## Chinese, Japanese, and Korean

- Nothing pops up while your input method is composing (pinyin, kana, and so on). Matching starts once the text is committed (`compositionend`).
- These languages don't put spaces between words, so the extension looks back up to *Lookback length* characters from the cursor and finds the **longest** ending that matches a page title. For example, with a page named 机器学习, typing 今天在看机器 matches 机器 and suggests 机器学习.

## Settings

Find them under Settings → Inline Autocomplete.

| Setting | Default | What it does |
|---|---|---|
| Enable | On | Turns suggestions on or off |
| Minimum characters | 2 | Characters needed before the cursor to start matching |
| Lookback length | 24 | How far back to look for a match in languages without spaces |
| Max page suggestions | 8 | How many pages to show |
| Delay (ms) | 90 | How long to wait after you stop typing |
| Skip daily notes pages | On | Leaves date pages out of the suggestions |
| Page link format | `[[page]]` | Insert `[[page]]` or `#tag` |
| Suggest blocks | On | Also suggest matching blocks |
| Minimum characters for blocks | 3 | Characters needed before blocks are searched |
| Max block suggestions | 5 | How many blocks to show |
| Block reference format | `((uid))` | Insert `((uid))` or `[text](((uid)))` |

The command palette has **Inline Autocomplete: Toggle** to turn suggestions on or off, and **Inline Autocomplete: Refresh page titles** to pick up pages created in the last 30 seconds.
