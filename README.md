# dsh-toolcall-text-guard

> 让 DeepSeek Harness（DSH）别在「活还没干完」的时候突然不动了。
>
> A zero-dependency DSH plugin that re-opens a turn when the model silently
> stops mid-work — structural detection only, no judge model, no extra tokens.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 它解决什么

用 DSH 干长活时，偶尔会出现「聊着聊着、干着干着就不动了」：进度停在中间，
没有报错，没有「已完成」，再发一句话它又能接上。

多数时候**进程没有崩、会话也没有死**。真正发生的是：模型那一步只输出了文本
（或只输出了思考），没有发出原生 `tool-call`，DSH 的循环据此认为「本轮说完了」，
派发 `agent/turn-stopping` 并写下 `turn/end completed`，然后等你说话。
用户界面上看到的就是「突然断了」。

这个插件挂在 `agent/turn-stopping` 上——**在收尾之前、不是收尾之后**——
判断最后一步到底是「真说完了」还是「说到一半」。后者会向同一回合补一句提示，
让循环再走一步，接着把活干完。

判别方法很简单：断的时候看会话日志最后有没有 `turn/end`。

| 日志结尾 | 含义 | 插件能做什么 |
| --- | --- | --- |
| 有 `turn/end completed` | 回合静默收尾，进程活着 | **能救**，本插件就是干这个的 |
| 日志突然截断、没有 `turn/end` | 进程真崩了 / 被杀了 | 救不了，只能重启后从事件流续上 |

## 与内置 `text-toolcall-guard` 的区别

DSH 自带一个 `@deepseek-ai/dsh-text-toolcall-guard` 插件（社区的一些 bundle
里也有它的 vendored 副本）。它管的是**一种**形态：
模型把工具调用写成行首的 `<tool_call>` / `<function=…>` 标记，于是那次调用
从来没被执行。

本插件**不是它的 fork**，也不重复它。它管的是更大的一类「回合静默收尾」：

| | 内置 `text-toolcall-guard` | 本插件 |
| --- | --- | --- |
| 触发范围 | 仅「文本形式的工具调用标记」 | 空回、只思考不落字、思考泄漏、残标签、半句截断、调完工具一字未说 |
| 判定对象 | 最后一条 assistant message | 整个回合的结构（是否曾调过工具、最后一步有没有调、文本形态） |
| 每轮次数上限 | 2 | 4（且带「上一次补救有没有生效」的探测，无效就停手） |
| 事后倒查 | 无 | 每判一次落一行日志，`why=` 可直接定位是哪种断法 |
| 依赖 | Cordis / Schemastery | 零依赖，只有 Node 内置模块 |

两者可以同时装，判定互不重叠。

## 识别哪些「断法」

判定纯看结构，不调用裁判模型、不消耗额外 token。`why=` 的完整取值：

| `why` | 最后一步长什么样 | 是否补话 |
| --- | --- | --- |
| `blank-after-tool` | 调完工具，一个字都没说 | 是 |
| `reasoning-only` | 只有思考块，没有正文 | 是 |
| `leak-unclosed` | `<analysis>…` 开标签没闭合 | 是 |
| `leak-no-body` | 思考/复盘标签闭合了，后面没正文 | 是 |
| `leak-inner-unclosed` | 前面一个空标签闭合后，又开了个思考块却没关 | 是 |
| `tag-shape` | 整段就一个残缺标签，如 `<ask_user_question">` | 是 |
| `json-tool-call` | 混进正文的 `"tool_calls":` 残片 | 是 |
| `tag-head` | 标签开头且很短，像没写完的调用头 | 是 |
| `half-sentence` | 停在逗号 / 分号 / 冒号 / 破折号上 | 是 |
| `leak-has-body` | 标签闭合后**有**真正的正文 | 否（人家说完了） |
| `text-too-long` | 普通长文超过 `maxChars` | 否 |
| `looks-complete` | 完整的正常回答 | 否 |
| `last-step-called-tool` / `no-tool-anywhere` / `no-message` / `disabled` | 前置门槛未满足 | 否 |

判据的重心是「**有没有说完、有没有给出内容**」，不是「开头是什么标签」。
标签后面跟了实实在在的回答就不打扰；只有一具复盘空壳、或者第二个思考块
写到一半就停了，才补话。

> 注意：`leak-*` 这几类**不受 `maxChars` 长度上限约束**——数万字的
> `<analysis>…</analysis>` 复盘当作正文吐出来、一个字的结论都没有，照样要救。

## 安装

插件是标准的 DSH / Cordis 插件包，`package.json` 里的 `dsh.bundle.patch`
指向自带的 `cordis.patch.yml`，安装后会自动插入层栈，不用手工改 profile 的
patch 文件。

```sh
# 1. 克隆到 DSH 的插件目录
git clone https://github.com/gpboyer2/dsh-toolcall-text-guard.git \
  ~/.dsh/plugins/dsh-toolcall-text-guard

# 2. 注册到要用的 profile（profile 名按你本机实际情况，常见是 desktop / web）
dsh plugin --profile desktop add link:$HOME/.dsh/plugins/dsh-toolcall-text-guard

# 3. 重启 DSH —— 插件是在启动时加载的，改完代码也必须重启才生效
```

`dsh plugin` 会把参数原样转给 profile 目录下的 pnpm，所以也可以直接用
`pnpm add link:/absolute/path`。验证加载成功：重启后随便跑一轮，看
`~/.dsh/logs/toolcall-guard.log` 有没有新增行。

自带的 `cordis.patch.yml` 内容：

```yaml
- insert:
    - id: toolcall-text-guard
      name: dsh-toolcall-text-guard
      config:
        enabled: true
        maxContinuations: 4
        debug: true
```

## 配置

| 项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `maxContinuations` | `4` | 每回合最多补几次，防无限重试；连续退化会提前停手 |
| `halfSentenceMax` | `200` | 半句判定的长度上限 |
| `fragmentMax` | `400` | 残标签 / 调用头判定的长度上限 |
| `maxChars` | `8000` | 普通长文超过就不再介入（**不影响** `leak-*` 判定） |
| `debug` | `true` | 每判一次写一行日志 |
| `logFile` | `~/.dsh/logs/toolcall-guard.log` | 日志位置 |
| `steerText*` | 见 `index.js` | 各类断法对应的补话文案，可自行改成中文/英文 |

## 事后倒查

每次判定都会落一行，格式（下面是一行**合成示例**，字段已占位化）：

```
2026-01-01T00:00:00.000Z | turn=1 | step=42 | why=leak-has-body | recover=false | model=<model-id> | used=0 | text="<redacted>"
```

再断一次的时候，看最后一行的 `why` 就知道是「真说完了」还是「又出现一种
没认出来的新形态」。后者补一条判据、跑一遍测试、重启即可——这个插件的判据
就是从日志里一条条长出来的。

**隐私**：`debug: true`（默认）会把最后一步文本的前 80 个字符写进本地日志，
方便倒查。日志只落在本机、不上传；如果对话内容敏感，把 `debug` 设为 `false`
即可完全关闭，或用 `logFile` 指到别处。

## 验证

```sh
node --test test/decide.test.mjs
```

覆盖全部 `why` 分支、前置门槛、思考泄漏的四种形态、正文与思考的边界、
`analyzeTurn` 的回合隔离。作者另外在本地 1571 条历史会话的「纯文本收尾」样本上
做过全量回放：新增判据只改变其中 3 条判定，全都是同一种「停在思考中途」的
形态，没有误伤任何一条完整回答。

## 局限

- **进程真崩救不了**：没有 `turn/end` 的事件流，插件没有任何介入时机。
- **结构判定有边界**：只认见过的形态。遇到全新的停止姿势可能漏判，但每次
  判断都有日志，能立刻定位并补规则。
- **不保证模型听话**：连续 4 次补话都没产生新内容就停手并写日志，不会烧 token。
- **必须重启生效**：DSH 启动时加载插件，热改文件不会自动重载。

## License

[MIT](LICENSE)
