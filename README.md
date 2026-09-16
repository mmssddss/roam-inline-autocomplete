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
| Tab | Insert the selected suggestion. Page: replaces the matched text with `[[Title]]` (or `#tag`). Block: replaces it with `((uid))` (or `[text](((uid)))`) |
| Enter | **Only inserts once you've pressed ↑ or ↓.** Until then it goes to Roam as usual and starts a new block — the popup appears on its own while you type, so it doesn't take over the key you press most |
| Esc | Close the suggestions. They won't reappear for the same word until you type a different word or move to another block |

To stay out of the way of Roam's own autocomplete, nothing pops up inside `[[ ]]`, `(( ))`, `{{ }}`, `#tag`, `/commands`, `attribute::`, or ``` code blocks.

## Suggestions

Color tells you what a suggestion is:

- **Pages** are the plain title in your theme's page-link color — no `[[ ]]` around it (a `#` goes in front if you insert tags).
- **Blocks** are in the normal text color, with a bullet and the page they're on underneath. Picking one inserts a block reference; it **never** creates a new page.

The part that matched is bold with a light background in both, so the color stays free to mean page or block.

Pages come first, then blocks, with a divider in between. Block search is on by default, starts at 3 characters, and shows up to 10 blocks. You can change these or turn it off in the settings. Blocks are searched by the whole word in front of the cursor; only if that finds nothing does it fall back to the shorter piece that matched a page title.

## Preview

The popup has two panes: suggestions on the left and a live preview of the selected one on the right (switch with ↑ / ↓ or by hovering). Key hints run along the bottom.

- Page: the title, how many blocks it has and how many linked references point to it, and an outline of the page.
- Block: the page it's on, the block's text, and its children.

The preview is read-only. It lightly styles `[[links]]`, `#tags`, `((references))` (shown as the referenced block's text), bold, italic, highlights, and code, and shows up to 28 blocks, 4 levels deep. In windows narrower than 640px, only the list is shown.

## Appearance

The popup takes its colors from whatever theme you are on, in light and dark alike. No setup needed.

- **Roam's own light and dark mode.** Instead of guessing at Roam's palette, the popup measures it: the background, text, page-link color, highlight, bullet, shadow, and corner radius Roam is actually using.
- **[Roam Studio](https://github.com/rcvd/RoamStudio).** Whichever theme (Craft, Things, Quattro, and so on) and appearance (Light / Dark / Auto) is active, read from Roam Studio's own variables.
- **Custom `roam/css` themes.** Same measuring, so most of them come through too.

Colors that would be hard to read are adjusted rather than dropped: a link color that falls just short of the 4.5:1 contrast ratio is lightened or darkened a little, keeping its hue. If a theme's colors can't be read at all, the popup falls back to its own light or dark palette.

Themes are measured once and cached until Roam's theme changes. If you edit your own CSS while Roam is open, run **Inline Autocomplete: Refresh theme colors** from the command palette.

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
| Max page suggestions | 25 | How many pages to show (the list scrolls) |
| Delay (ms) | 90 | How long to wait after you stop typing |
| Skip daily notes pages | On | Leaves date pages out of the suggestions |
| Page link format | `[[page]]` | Insert `[[page]]` or `#tag` |
| Suggest blocks | On | Also suggest matching blocks |
| Minimum characters for blocks | 3 | Characters needed before blocks are searched |
| Max block suggestions | 10 | How many blocks to show |
| Block reference format | `((uid))` | Insert `((uid))` or `[text](((uid)))` |

The command palette has **Inline Autocomplete: Toggle** to turn suggestions on or off, **Inline Autocomplete: Refresh page titles** to pick up pages created in the last 30 seconds, and **Inline Autocomplete: Refresh theme colors** to re-read the theme after you change your CSS.
