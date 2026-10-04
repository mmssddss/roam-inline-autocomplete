# roam-inline-autocomplete

Roam Research 插件（Roam Depot 扩展格式）。在 block 编辑框里边打字边弹出候选，不用先输 `[[`：页面候选插入 `[[标题]]`，block 候选插入 `((uid))`。重点照顾中日韩输入法。功能说明见 [README.md](README.md)。

## 文件

- `extension.js`：全部代码。ES module，`export default { onload, onunload }`，Roam 直接加载这个文件。
- `README.md`：给用户看的安装、用法、设置说明。
- `LICENSE`：MIT。
- `CHANGELOG.md`：Keep a Changelog 格式，Roam Depot 会读它显示更新日志。发版本时加一节，日期写绝对日期。
- `resource/`：README 用到的图，目前只有一个演示 GIF。

没有 package.json、依赖、构建步骤和自动化测试。除非我明确要求，不要引入 npm 包、打包工具或 TypeScript。

## 验证改动

- 命令行能做的只有语法检查：

  ```bash
  node --check extension.js
  ```

- 行为只能在 Roam 里手动验证：Settings → Roam Depot → Developer Extensions → 这个扩展的 Reload。
- 所以改完要列出需要我手测的场景。常用回归清单：英文输入；中文拼音（组词中不弹，上屏后才弹）；在 `[[ ]]`、`(( ))`、`#tag`、代码块里不触发；Enter / Tab / Esc / ↑↓；候选多到列表要滚动时 ↑↓ 到底弹层不关；Roam 原版浅色 / 深色；装了 Roam Studio 时换几个主题和 Light / Dark / Auto；窄窗口（< 640px 只显示列表）；挪光标后 Enter 不替换错、照常换行；停手约 250ms block 追加在页面后面、选中项不动；只有 block 命中时弹层晚出现，紧接着按的 Enter 照常换行。

## 代码地图

`extension.js` 用注释横幅分段，从上到下：

- **设置**：`setting(id)` 读 `extensionAPI.settings`，空值回退到 `DEFAULTS`。输入框类设置存的是字符串，在这里转成数字，非正数也回退默认值（`ZERO_OK` 里的延迟类设置允许 0）。
- **标题缓存与匹配**：全图谱页面标题缓存 30 秒（新建的页面最多晚 30 秒才出现；命令面板有 Refresh page titles）。`tailBeforeCursor` 取光标前到最近分隔符（`DELIM_RE`）为止的文字；`findPageMatches` 从最长后缀往短试，命中就停，中文不分词也能匹配就靠这个。`scanBlocks` 在 datascript 里用正则搜 block（`(?i)` 前缀走 ClojureScript 的 `re-pattern`，万一哪天不认了会自动降级成大小写敏感）。`findBlockMatches` 里 block **先用光标前的整个词**，搜不到（或不够长）才退到页面命中的那段 —— 反过来的话，打「动态的效果」时页面只命中后缀「效果」，block 就跟着只搜「效果」。两个候选由 `blockCandidates` 给出，页面那段是整个词的后缀、结果是超集，所以只拿短的那个扫**一次**，整个词的结果在 JS 里从中筛。门槛由 `blockMinFor` 定：含中日韩字（`CJK_RE`）用 `blockMinChars`（默认 3），其他文字用 `blockMinCharsLatin`（默认 4）。
- **block 扫描缓存**：`blockCache` 存上一次扫描的**完整**结果（不截断，只留前 N 条会丢匹配）。新词包含上次的词（mach → machi）就用 `filterRows` 在缓存里筛，不再扫图谱（`blockCacheCovers` 判断）。换 textarea、`close()`、新词不包含旧词、超过 30 秒作废；evaluate() 里页面没命中、只是先藏弹层等 block 时，以及 IME 组词开始时用 `close({ keepBlockCache: true })` 留着它。排除当前 block / 空串 / 原文等于 q、挑最短的 `blockMaxResults` 条都在 `toBlockItems` 里、缓存筛完之后做，挑最短用小数组插入，不整体排序。
- **光标坐标**：mirror div 法算 textarea 里光标的屏幕坐标，用来定位弹层。
- **列表渲染**：`render()` 只在候选变了时重建 DOM，`setActive()` 换高亮行时不重建（候选默认 25 + 10 条，↑↓ 每按一次都重建会卡）。加新的列表交互时别退回去整个 `innerHTML` 重刷。
- **弹层**：上面左右两栏（候选列表 / 预览），底部一行按键提示。页面候选只显示标题（`pageLabel`，tag 模式加个 `#`），整行走 `--ac-accent`；block 候选是圆点 + 原文 + 所在页面，走 `--ac-text`。**颜色只用来区分页面和 block**，命中片段一律加粗 + `--ac-line` 底色，别再给它上强调色。
- **预览**：用 `pull` 拉子树，渲染成带竖线的嵌套大纲（`outlineHtml`），结果缓存到 `close()` 为止。
- **写回 textarea**：`commit()` 把光标前的 `item.q` 替换成 `buildInsert(item)` 的结果。替换前先核对光标前那段确实等于 `item.q`（且没有选区），对不上就 `close()` 并返回 `false`，`onKeyDown` 收到 `false` 就不拦这个键，Enter 照常换行。
- **事件**：document / window 上的捕获阶段监听。`evaluate()` 是「要不要弹」的总入口，分两段：页面候选当场算、弹层当场开；block 如果缓存能回答也当场算、一起显示，否则交给 `scheduleBlockSearch` 等停手 `blockDelayMs`（默认 250）再扫。定时器触发时 `blockRequestLive` 核对 `state.seq`、焦点、光标位置、光标前的词、IME、Esc，有一样变了就丢掉结果。结果到了：弹层开着就 `appendItems` 追加在后面，不动已有行和选中项；弹层关着（页面没命中）才打开，并记下 `state.lateOpenAt`，之后 200ms（`LATE_OPEN_GRACE_MS`）内的 Enter / Tab 直接放行给 Roam。←/→/Home/End 放行后 `schedule()` 按新光标位置重新匹配。
- **样式**：一段 CSS 字符串注入 `<style>`。颜色全是 `#rr-inline-ac` 上的 `--ac-*` 变量，浅色 / 深色两套兜底值在 `LIGHT_VARS` / `DARK_VARS`。
- **主题适配**：`applyTheme()` 每次打开弹层时跑，把当前主题折算成 `--ac-*` 内联写在弹层上。取色来源从高到低：Roam Studio 注入到 `:root` 的 `--bc-*/--co-*/--sd-*/--bd-*` 变量（`readStudioVars`）→ 页面上真实 Roam 元素的 computed style，页面上没有的元素照 `PROBE_HTML` 搭一份离屏的量，量完立刻删（`sampleRoamDom`）→ CSS 兜底。深浅色由 `isDarkUI()` 判定后加 `.rr-ac-light` / `.rr-ac-dark`，不指望 `.bp3-dark` 一定是弹层的祖先。结果按 `themeKey()`（html/body 的 class + Studio 样式长度 + 系统深浅）缓存，命令面板的 Refresh theme colors 清缓存。
- **生命周期**：`onload` 注册设置面板、命令面板和监听；`onunload` 全部撤销。

## 必须遵守的约束

- **能卸载干净**：Roam 会在不刷新页面的情况下 reload / 卸载扩展。事件监听一律通过 `on()` 注册（记进 `listeners`，`onunload` 统一移除）；新加的 DOM 节点、定时器也要在 `onunload` 里清掉。
- **写 textarea 必须用 `nativeSetValue` 并派发 `input` 事件**。直接 `ta.value = ...` 不会同步到 Roam 的 React 状态。写之前设 `state.ignoreNextInput = true`，不然自己派发的 input 会再次触发候选。
- **只在弹层打开时拦截按键**。`onKeyDown` 在捕获阶段 `stopImmediatePropagation`，是为了抢在 Roam 之前处理 Enter / Tab；弹层关着时必须原样放行，否则会破坏 Roam 的正常编辑。
- **IME**：`state.composing` 为真时什么都不做，只在 `compositionend` 之后匹配。改输入相关逻辑时不要破坏这一点。
- **不和 Roam 原生补全抢**：哪些位置不触发由 `insideRoamSyntax` 和 `roamAutocompleteVisible` 决定，新的排除规则加在 `insideRoamSyntax` 里。
- **弹层内部的滚动不能关弹层**：scroll 监听挂在 window 的捕获阶段，会收到所有元素的滚动；`onScroll` 必须跳过来自弹层内部的事件，否则列表一滚动（包括 ↑↓ 触发的 `scrollIntoView`）弹层就没了。
- **HTML 先转义**：图谱内容是不可信输入，拼进 `innerHTML` 的文本都要先过 `escHtml`。`formatInline` 是先整体转义、再往上加标签，新增格式化规则时保持这个顺序。
- **Datalog 查询**：用户输入作为 `:in` 参数传，不要拼进查询字符串；放进正则前先 `escapeRegex`。block 过滤留在 datascript 里做，不要把全图谱的 block 拉到 JS 里再筛，大图谱会卡。唯一的例外是 `blockCache`：它只是上一次正则扫描**命中的那些行**，在它里面用 JS 再筛是刻意的（词变长时免得每个键都扫一遍图谱），别把它当成违规删掉，也别把它改成只缓存前 N 条。
- **一次求值最多扫一遍图谱**：200k block 的图谱一次扫描大约 100ms。别回到「整个词扫一遍、搜不到再用页面那段扫一遍」的写法，也别让 block 扫描跟着每个键跑（`blockDelayMs` 只管真正的扫描，缓存能答的不等）。
- **主题色都要过对比度**：`deriveTheme()` 里正文、次要文字、强调色、高亮文字在各自底色上都要 ≥ 4.5:1。主题给的颜色差一点点时用 `fitContrast()` 保住色相微调明度，不要直接丢掉换成正文色（Roam 自带深色的链接蓝就只有 4.4:1）；底色和正文本身就读不了才整体返回 `null` 回到 CSS 兜底。
- **探针不能留在页面上**：`sampleRoamDom()` 插的离屏节点必须在 `finally` 里删掉，它只是用来量颜色的，别让 Roam 的 React 树看到多余节点。
- **弹层必须赶在下一次按键之前出现**：`debounceMs` 默认 0，弹层也没有淡入动画。Enter 默认插入第一个候选，所以晚一拍冒出来的弹层会把用户正要按的换行键抢走 —— 这是刻意取舍，别为了「顺滑」把默认延迟或入场动画加回来。这条管的是**页面候选**：它们查缓存好的标题，必须每个键当场出。block 扫图谱太贵，是唯一刻意延后的（`blockDelayMs`），为此有两道保护，改的时候别拆：已打开的弹层只追加不换选中项；由晚到的 block 打开的弹层，前 200ms 的 Enter / Tab 放行给 Roam。
- **`item.q` 必须是真正匹配上的那一段**：`commit()` 靠 `cursor - item.q.length` 回退光标，q 短一个字，插入就变成「机[[机器学习]]」（现在 `commit()` 会核对、对不上就不插，但那等于这个候选永远选不上）。block 候选的 q 是整个词或页面命中的那段，取决于用哪个候选筛出了结果，别统一写成 tail。改 `findPageMatches` 的命中条件时特别小心：某一轮被过滤成空，循环会退到更短的后缀，同一个页面可能被 `includes` 捞回来，但 q 已经错位了。
- **命名前缀**：DOM id / class 用 `rr-inline-ac`、`rr-ac-`、`rr-pv-` 前缀，CSS 选择器都挂在 `#rr-inline-ac` 下面，避免影响 Roam 自己的样式。
- **依赖 Roam DOM 约定的地方比较脆**：block 输入框靠 `textarea.rm-block-input` 识别；当前 block uid 取 textarea id 的最后 9 个字符；原生补全是否打开看 `.rm-autocomplete__results`；深色主题看 `.bp3-dark` 等祖先 class。Roam 改版后出问题先查这几处。

## 加 / 改设置

要同步改四处：`DEFAULTS`；`onload` 里的 `settings.panel.create`；默认开启的开关还要加进 `onload` 的首次安装初始化（不然设置面板里显示成关）；README 的「Settings」表格。`select` 类设置的选项文字会在代码里直接做字符串比较（如 `"#tag"`、`"[text](((uid)))"`），改选项文字要连代码一起改。

数字设置填 0 或负数会回退默认值，延迟类除外：`debounceMs`、`blockDelayMs` 在 `ZERO_OK` 里，0 是合法值（不等）。新加延迟类设置要加进去。

## 风格

- 2 空格缩进、双引号、分号。不用 class，用模块级函数加 `state` 等模块级变量。
- 界面文案（设置面板、弹层、命令面板）和 README 一律用英文；代码注释用中文。
- 改颜色只改 `--ac-*` 变量，浅色和深色两套都要改，并检查文字对比度（正文和命中高亮在选中行背景上也要 ≥ 4.5:1）。
- 改了按键、触发规则、设置或插入格式，同步更新 README。
