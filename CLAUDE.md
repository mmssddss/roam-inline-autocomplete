# roam-inline-autocomplete

Roam Research 插件（Roam Depot 扩展格式）。在 block 编辑框里边打字边弹出候选，不用先输 `[[`：页面候选插入 `[[标题]]`，block 候选插入 `((uid))`。重点照顾中日韩输入法。功能说明见 [README.md](README.md)。

## 文件

- `extension.js`：全部代码。ES module，`export default { onload, onunload }`，Roam 直接加载这个文件。
- `README.md`：给用户看的安装、用法、设置说明。

没有 package.json、依赖、构建步骤和自动化测试。除非我明确要求，不要引入 npm 包、打包工具或 TypeScript。

## 验证改动

- 命令行能做的只有语法检查：

  ```bash
  node --check extension.js
  ```

- 行为只能在 Roam 里手动验证：Settings → Roam Depot → Developer Extensions → 这个扩展的 Reload。
- 所以改完要列出需要我手测的场景。常用回归清单：英文输入；中文拼音（组词中不弹，上屏后才弹）；在 `[[ ]]`、`(( ))`、`#tag`、代码块里不触发；Enter / Tab / Esc / ↑↓；候选多到列表要滚动时 ↑↓ 到底弹层不关；浅色和深色主题；窄窗口（< 640px 只显示列表）。

## 代码地图

`extension.js` 用注释横幅分段，从上到下：

- **设置**：`setting(id)` 读 `extensionAPI.settings`，空值回退到 `DEFAULTS`。输入框类设置存的是字符串，在这里转成数字，非正数也回退默认值。
- **标题缓存与匹配**：全图谱页面标题缓存 30 秒（新建的页面最多晚 30 秒才出现；命令面板有 Refresh page titles）。`tailBeforeCursor` 取光标前到最近分隔符（`DELIM_RE`）为止的文字；`findPageMatches` 从最长后缀往短试，命中就停，中文不分词也能匹配就靠这个。`queryBlocks` 在 datascript 里用正则搜 block。
- **光标坐标**：mirror div 法算 textarea 里光标的屏幕坐标，用来定位弹层。
- **弹层**：上面左右两栏（候选列表 / 预览），底部一行按键提示。页面候选按插入后的样子显示成 `[[标题]]`（`pageLabel`），block 候选是圆点 + 原文 + 所在页面。
- **预览**：用 `pull` 拉子树，渲染成带竖线的嵌套大纲（`outlineHtml`），结果缓存到 `close()` 为止。
- **写回 textarea**：`commit()` 把光标前的 `item.q` 替换成 `buildInsert(item)` 的结果。
- **事件**：document / window 上的捕获阶段监听。`evaluate()` 是「要不要弹」的总入口。
- **样式**：一段 CSS 字符串注入 `<style>`。颜色全是 `#rr-inline-ac` 上的 `--ac-*` 变量，深色主题只覆盖这些变量。Roam Studio 适配是打开弹层时用 JS 读它注入到 `:root` 的 `--bc-*/--co-*` 变量算成 `--ac-*` 写在弹层元素上；变量为空时换候选，读不到就回自带样式。
- **生命周期**：`onload` 注册设置面板、命令面板和监听；`onunload` 全部撤销。

## 必须遵守的约束

- **能卸载干净**：Roam 会在不刷新页面的情况下 reload / 卸载扩展。事件监听一律通过 `on()` 注册（记进 `listeners`，`onunload` 统一移除）；新加的 DOM 节点、定时器也要在 `onunload` 里清掉。
- **写 textarea 必须用 `nativeSetValue` 并派发 `input` 事件**。直接 `ta.value = ...` 不会同步到 Roam 的 React 状态。写之前设 `state.ignoreNextInput = true`，不然自己派发的 input 会再次触发候选。
- **只在弹层打开时拦截按键**。`onKeyDown` 在捕获阶段 `stopImmediatePropagation`，是为了抢在 Roam 之前处理 Enter / Tab；弹层关着时必须原样放行，否则会破坏 Roam 的正常编辑。
- **IME**：`state.composing` 为真时什么都不做，只在 `compositionend` 之后匹配。改输入相关逻辑时不要破坏这一点。
- **不和 Roam 原生补全抢**：哪些位置不触发由 `insideRoamSyntax` 和 `roamAutocompleteVisible` 决定，新的排除规则加在 `insideRoamSyntax` 里。
- **弹层内部的滚动不能关弹层**：scroll 监听挂在 window 的捕获阶段，会收到所有元素的滚动；`onScroll` 必须跳过来自弹层内部的事件，否则列表一滚动（包括 ↑↓ 触发的 `scrollIntoView`）弹层就没了。
- **HTML 先转义**：图谱内容是不可信输入，拼进 `innerHTML` 的文本都要先过 `escHtml`。`formatInline` 是先整体转义、再往上加标签，新增格式化规则时保持这个顺序。
- **Datalog 查询**：用户输入作为 `:in` 参数传，不要拼进查询字符串；放进正则前先 `escapeRegex`。block 过滤留在 datascript 里做，不要把全图谱的 block 拉到 JS 里再筛，大图谱会卡。
- **命名前缀**：DOM id / class 用 `rr-inline-ac`、`rr-ac-`、`rr-pv-` 前缀，CSS 选择器都挂在 `#rr-inline-ac` 下面，避免影响 Roam 自己的样式。
- **依赖 Roam DOM 约定的地方比较脆**：block 输入框靠 `textarea.rm-block-input` 识别；当前 block uid 取 textarea id 的最后 9 个字符；原生补全是否打开看 `.rm-autocomplete__results`；深色主题看 `.bp3-dark` 等祖先 class。Roam 改版后出问题先查这几处。

## 加 / 改设置

要同步改四处：`DEFAULTS`；`onload` 里的 `settings.panel.create`；默认开启的开关还要加进 `onload` 的首次安装初始化（不然设置面板里显示成关）；README 的「Settings」表格。`select` 类设置的选项文字会在代码里直接做字符串比较（如 `"#tag"`、`"[text](((uid)))"`），改选项文字要连代码一起改。

## 风格

- 2 空格缩进、双引号、分号。不用 class，用模块级函数加 `state` 等模块级变量。
- 界面文案（设置面板、弹层、命令面板）和 README 一律用英文；代码注释用中文。
- 改颜色只改 `--ac-*` 变量，浅色和深色两套都要改，并检查文字对比度（正文和命中高亮在选中行背景上也要 ≥ 4.5:1）。
- 改了按键、触发规则、设置或插入格式，同步更新 README。
