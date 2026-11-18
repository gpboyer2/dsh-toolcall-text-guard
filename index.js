/**
 * `dsh-toolcall-text-guard`
 *
 * 兜住「回合静默收尾」：模型最后一步只吐文本或只吐思考，没有真正的
 * tool-call，DSH 的循环据此认为本轮说完了，直接收尾。用户侧看到的就是
 * 「干着干着突然不动了」。
 *
 * 常见的几类断法：
 *   A. 空回：text 为空、只有 reasoning，stopReason=stop（模型想完就停）；
 *   B. 残标签：text 就是一个残缺的工具标签，如 `<ask_user_question">`；
 *   C. 半句：text 停在一句话中间，以逗号/分号/破折号收尾；
 *   D. 思考泄漏：整段 `<analysis>…</analysis>` 复盘当正文吐出来，一个字
 *      结论都没有（可能长达数万字）；或者开头一个空 `<thinking> </thinking>`
 *      之后又开了一个思考块、却没闭合就停了。
 *   E. 调完工具一个字没说就收尾。
 *
 * 判据的重心是「有没有说完、有没有给出内容」，不是「开头是什么标签」：
 * 标签后面有真正的正文就不打扰，只有复盘空壳或说到一半才补话。
 *
 * 判定纯结构，不调裁判模型、不花额外 token。每轮有次数上限，且每判一次
 * 都落一行日志到 ~/.dsh/logs/toolcall-guard.log，事后能倒查是哪一种断法。
 * 进程真崩（事件流里没有 turn/end）不在本插件能力范围内。
 *
 * @module dsh-toolcall-text-guard
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 插件 id，cordis.patch.yml 里的 id 要和它一致。 */
export const name = 'toolcall-text-guard'

/** 只用事件，不依赖额外服务。 */
export const inject = []

/** 注入消息的来源标记，便于在会话里区分是插件补的。 */
const PLUGIN_SOURCE = { kind: `plugin:${name}` }

/** 默认日志路径。 */
const DEFAULT_LOG = path.join(os.homedir(), '.dsh', 'logs', 'toolcall-guard.log')

/** 默认配置。 */
export const DEFAULTS = {
  enabled: true,
  /** 每轮最多补救几次。浮华通道不稳定，给到 6 次；probe 判定无进展会提前停手。 */
  maxContinuations: 6,
  /** 半句判定的长度上限（超过这个长度就按正常正文对待）。 */
  halfSentenceMax: 200,
  /** 标签/JSON 残片判定的长度上限，避免把长解释当成调用。 */
  fragmentMax: 400,
  /** 文本长于这个长度就不管。 */
  maxChars: 8000,
  /** 命中后注入的提示（残标签 / JSON 调用）。 */
  steerText:
    '你上一条回复把工具调用写成了正文文本，并没有真正发起调用，所以这一轮被当成结束了。'
    + '现在直接发起真正的工具调用（不要用文字描述命令），继续完成手上的任务。',
  /** 空白收尾（调完工具后一个字没说）时注入的提示。 */
  steerTextBlank:
    '你刚调完工具、结果已经回来了，但这一轮一个字都没说就结束了。'
    + '现在继续：要么直接发起下一步工具调用把活干完，要么用一句话说清当前结果。',
  /** 只思考不落字时的提示。 */
  steerTextReasoning:
    '你这一轮只输出了思考、没有正文也没有工具调用，所以被当成结束了。'
    + '现在把结论用一两句话写出来，或者直接发起下一步工具调用。',
  /** 半句截断时的提示。 */
  steerTextHalf:
    '你上一条回复停在一句话中间就结束了。'
    + '现在接着说完；如果还有活没干完，直接发起工具调用继续。',
  /** 思考泄漏且没有收尾（停在分析中间）时的提示。 */
  steerTextLeak:
    '你上一条回复停在思考过程中间就结束了，没有真正继续任务。'
    + '不要继续输出分析；直接发起下一步工具调用，或者用一两句话给出结论。',
  /** 思考回声（把独白当正文吐出来）时的提示。 */
  steerTextEcho:
    '你上一条回复把内部思考原样当成正文输出了一遍，用户看到的是一段独白，不是答案。'
    + '现在重新回答：直接给结论和能照着做的做法，不要复述你的分析过程。',
  /** 过渡句收尾（说了下一步、动作没发生）时的提示。 */
  steerTextPlan:
    '你上一条回复只交代了「接下来要做什么」，然后就结束了，那个动作并没有真的发生。'
    + '现在直接去做：立刻发起相应的工具调用，不要再用文字描述下一步。',
  /** 退化重复泄漏（正文被同一句反复改写撑长、行首挂着思考闭合标签）时的提示。 */
  steerTextDegenerate:
    '你上一条回复把思考标签和同一句「接下来要做什么」反复重复了十几遍，正文已经碎成一片，'
    + '那个动作一次都没有真的发生。现在直接发起工具调用把它做掉，不要再重复描述计划。',
  /** 正文末尾拖着思考闭合标签、只剩一句短话时的提示。 */
  steerTextLeakTail:
    '你上一条回复在一句很短的话后面直接挂了思考闭合标签，那多半是思考写到一半漏进了正文，'
    + '动作还没发生。现在直接发起工具调用接着做；如果你本来要给结论，就把话说完整。',
  /** 浮华通道只给了半截、没交出「当前情况 / 做了哪些」两节时的提示。 */
  steerTextFuhua:
    '你这一轮没有给出「当前情况」和「做了哪些」这两节，按约定这算没干完就停了。'
    + '现在二选一：已经做完的，用「当前情况」（一句话说清状态）和「做了哪些」（你实际动了什么）两节汇报；'
    + '还没做完的，立刻发起下一步工具调用继续做，不要只描述计划。'
    + '如果你确实在等我回答、或者等子代理返回，就明说在等什么。',
  /** 工具调用标签裸露在正文里时的提示。 */
  steerTextExposed:
    '你上一条回复把工具调用写成了正文，界面上能直接看到 <parameter>、</bash>、</thought> 这些标签，'
    + '真正的调用没有发出去，所以这一轮被当成结束了。'
    + '现在用真正的工具调用把这一步重新发一次（不要再写标签文本），然后继续把活干完。',
  /** 判一次写一行日志，便于事后倒查。 */
  debug: true,
  logFile: DEFAULT_LOG,
}

/** 整段文本就是一个标签：`<ask_user_question">`、`</bash>`、`<tool_call>`。 */
const TAG_ONLY = /^\s*<\s*\/?\s*[A-Za-z_][\w-]*\s*["']?\s*>\s*$/

/** 以标签开头，后面可能跟参数（残留的调用头）。 */
const TAG_HEAD = /^\s*<\s*[A-Za-z_][\w-]*\s*["']?\s*>/

/** OpenAI 风格的 JSON 调用残片。 */
const JSON_CALL = /"tool_calls"\s*:/

/** 思考泄漏：正文以分析/复盘类标签开头，长度不限（可能是数万字的复盘）。 */
const LEAK_HEAD = /^\s*<\s*(analysis|thinking|thought|reasoning|cot|summary|reflection|scratchpad|分析|思考|摘要|复盘)(?=[\s>]|$)/i

/** 所有闭合标签（全局），取最后一个，看它后面还剩什么。 */
const LEAK_CLOSE_ALL = /<\/(analysis|thinking|thought|reasoning|cot|summary|reflection|scratchpad|分析|思考|摘要|复盘)\s*>/gi

/** 单个开标签，用来发现「闭合之后又开了一个思考块」。 */
const LEAK_OPEN_ONE = /<\s*(analysis|thinking|thought|reasoning|cot|summary|reflection|scratchpad|分析|思考|摘要|复盘)(?=[\s>]|$)[^>]*>/i

/**
 * 整段只剩残缺的工具/XML 标签，没有半个字正文，如 `<parameter name="edit">`、
 * `<function=foo>`、`</tool_call>`。思考标签闭合之后剩下的若是这种东西，
 * 那是把工具调用写坏了，不是正文。
 */
const RESIDUAL_TAGS_ONLY = /^(?:\s*<\s*\/?\s*[A-Za-z_][\w:.-]*(?:\s*[^<>]*)?\s*>\s*)+$/

/**
 * 整段以工具调用的参数标签开头，如
 * `<parameter name="description" string="true">Check backend process and health`。
 * 正常回复绝不会从参数标签起头，一旦这样起头，就是把工具调用当正文写了；
 * 不管标签后面跟没跟正文，只要整段没把调用写完整，就是「工具调用写坏了」。
 * 注意：不能复用 RESIDUAL_TAGS_ONLY —— 那条要求整段只剩标签，标签后带正文就漏判。
 */
const TAG_CALL_HEAD = /^\s*<\/?\s*(?:parameter|function_calls?|invoke|antml:invoke|antml:parameter)\b/i

/** 一句话没说完的收尾。 */
const HALF_TAIL = /[，,；;：:、—]$/

/**
 * 行首就是思考闭合标签。正文里本不该出现这种东西：正常输出最多在开头带一个
 * `<thinking> </thinking>` 壳（那种由 leak-* 系列按「闭合之后有没有正文」处理）。
 * 一旦整段被切成多行、其中两行以上以闭合标签起头，就是思考块反复泄漏进正文了。
 */
const LEAK_CLOSE_LINE_HEAD = /^\s*<\s*\/\s*(analysis|thinking|thought|reasoning|cot|summary|reflection|scratchpad|分析|思考|摘要|复盘)\s*>/i

/**
 * 正文末尾挂着思考闭合标签。正常回复不会以 `</thinking>` 收尾：要么根本没有标签，
 * 要么开头带一个空壳。落在句尾，说明思考块漏出来、并且话没说完。
 */
const LEAK_CLOSE_TAIL = /<\/(analysis|thinking|thought|reasoning|cot|summary|reflection|scratchpad|分析|思考|摘要|复盘)\s*>\s*$/i

/** 所有思考标签（开或闭、全局），用来把一段话剥干净再量长度。 */
const LEAK_TAGS_ALL = /<\/?\s*(analysis|thinking|thought|reasoning|cot|summary|reflection|scratchpad|分析|思考|摘要|复盘)\s*>/gi

/**
 * 过渡句收尾：模型说完「现在/接着/最后 + 要做的事」就停了，动作没发生。
 * 这类文本本身通顺、以句号结尾，靠「残缺」判断抓不到，只能靠结构特征收窄：
 * 极短、没有章节标题、不是在问用户、不是在等谁、没有交付物。
 */
const PLAN_TAIL_MAX = 300
/** 必须有「什么时候 + 去干什么」的承诺句，光有动词不算。 */
const PLAN_TAIL_ACT = /(现在|接下来|下一步|接着|然后|最后|继续)[^。；\n]{0,40}(跑|做|审|查|改|提交|推送|验证|复核|处理|执行|统一|修|补|加|写|确认|对账|验收)|先[^。；\n]{0,10}(跑|做|审|查|改|提交|推送|验证|复核|处理|执行|统一|修|补|加|写|确认|对账|验收)/
/** 有章节标题 = 在汇报，不是在交代下一步。 */
const PLAN_TAIL_HEADING = /^#{2,3}\s/m
/** 结尾在问用户 = 该用户说话了。 */
const PLAN_TAIL_ASK = /[？?]\s*$/
/** 带链接 = 交了东西出来。 */
const PLAN_TAIL_LINK = /\[[^\]]+\]\([^)]+\)/
/** 说清已经做完 = 真收尾。 */
const PLAN_TAIL_DONE = /交付完成|已交付|已推送|已提交|已合并|已修复/
/** 在等子代理、等结果、等用户拍板 = 该结束。 */
const PLAN_TAIL_WAIT = /等待|稍等|静待|你看|您看|你确认|你同意|你点头|可以我就|行我就|没问题我就|你定|你拍板|等[^。；\n]{0,8}(它|他|她|你|您|我|子代理|任一|结果|消息|完成|回来|返回|结束|交付|汇报|回报|腾出|落地)|只等|请告诉我|你说一声|要不要|需要我|要改吗|你看一下|请确认/

/**
 * 是不是「说完下一步就停」的过渡句。
 * 只认结构，不认语义：正常汇报有标题/链接/完成态，正常等待有等待词，正常提问有问号。
 */
export function isPlanTail(text) {
  const t = String(text ?? '').trim()
  if (t.length === 0 || t.length > PLAN_TAIL_MAX) return false
  if (PLAN_TAIL_HEADING.test(t)) return false
  if (PLAN_TAIL_ASK.test(t)) return false
  if (PLAN_TAIL_LINK.test(t)) return false
  if (PLAN_TAIL_DONE.test(t)) return false
  if (PLAN_TAIL_WAIT.test(t)) return false
  if (RESIDUAL_TAGS_ONLY.test(t) || TAG_CALL_HEAD.test(t)) return false
  return PLAN_TAIL_ACT.test(t)
}

/**
 * 浮华两个直连供应商（`fuhua/` 与 `fuhua-mac/`）。
 *
 * 这两个通道会把工具调用写成 `<tool_call>{...}</tool_call>` 这类正文，或者干脆
 * 把 `tools` 字段吞掉让模型声称「没有工具可用」——两种情况 DSH 都收不到
 * `tool_calls`，于是按设计把这一轮当成说完了。判据不能只看文本形态，
 * 得改看交付物：干过活就必须交出「当前情况」和「做了哪些」两节。
 */
const FUHUA_PROVIDER = /^fuhua(?:-mac)?\//i

export function isFuhuaModel(model) {
  return typeof model === 'string' && FUHUA_PROVIDER.test(model.trim())
}

/** 「当前情况 / 做了哪些」两节，允许 `##`、`**`、`>` 这些常见写法，但必须落在行首。 */
const SECTION_STATUS = /(?:^|\n)[\s>*#-]{0,6}当前情况/
const SECTION_DONE = /(?:^|\n)[\s>*#-]{0,6}做了哪些/

export function hasReportSections(text) {
  const t = String(text ?? '')
  return SECTION_STATUS.test(t) && SECTION_DONE.test(t)
}

/**
 * 真的在等人或等子代理返回，允许就此收尾，不算中途退出。
 *
 * 只看结尾，不看全文。整段里随便一个「要不要」不能算等待——真实误判
 * （会话 b3f01671 turn 2）：「先验证直连 MiniMax 是否正常，再决定要不要动 Clash。」
 * 这里「要不要」是它自己的计划，不是问用户，却把浮华判据整条挡掉了。
 */
export function looksLikeWaiting(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  // 结尾是问句：话头已经递回给用户了。
  if (/[？?]\s*$/.test(t)) return true
  // 只检查结尾一小段，避免句中的「要不要/需要我」被当成等待。
  const tail = t.slice(-80)
  return /等待|稍等|静待|只等|等[^。；\n]{0,8}(它|他|她|你|您|我|子代理|任一|结果|消息|完成|回来|返回|结束|交付|汇报|回报|腾出|落地)/.test(tail)
}

/**
 * 退化重复泄漏：整段被切成多行，其中两行以上以思考闭合标签起头。
 *
 * 典型形态（会话 324afd75 第 2 轮第 38 步，748 字 / 18 行、17 个行首 `</thinking>`）：
 * 模型把「现在要去做 X」这句话反复改写，每行前面挂一个闭合标签，越写越短，
 * 最后落到「先测。」这类碎片上就结束了——动作一次都没发生。
 * 这类重复把长度撑过 plan-tail 的 300 字上限，让那条判据整段失效，必须单独兜住。
 * 判据只看结构：正常回复不会在正文里塞两个以上的行首闭合标签。
 */
export function isDegenerateLeak(text) {
  // 以思考开标签起头的整段（含十几份压缩摘要）由 leak-* 系列按「闭合后有没有正文」处理，
  // 这里只看「没有开标签、却反复出现行首闭合标签」那种碎片。
  if (LEAK_HEAD.test(String(text ?? ''))) return false
  const lines = String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
  if (lines.length < 2) return false
  const heads = lines.filter((s) => LEAK_CLOSE_LINE_HEAD.test(s)).length
  if (heads < 2) return false
  // 剥掉标签后还要剩实际正文；只剩一串残标签的走 tag-* 那几条。
  const bare = lines.map((s) => s.replace(LEAK_CLOSE_LINE_HEAD, '').trim()).filter(Boolean)
  return bare.length >= 2 && bare.some((s) => s.length >= 8)
}

/**
 * 收尾挂标签：末句后面拖着思考闭合标签，剥掉标签后只剩一句很短的话。
 *
 * 典型形态（会话 72688503 第 1 轮第 20 步）：正文是「查一下依赖装在哪。</thinking></thinking>」，
 * 32 个字符、剥完只剩 9 个字；整轮 20 步都在调工具，这一步既没发起调用也没给结论，
 * 于是轮次被判成完成。plan-tail 认不出它——那句里没有「现在/先」这类前缀词。
 * 判据只看结构：标签落在结尾 + 剥掉后没有实质内容。
 */
export function isLeakTailStub(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  // 以开标签起头的整段（含长复盘）由 leak-* 按「闭合后有没有正文」处理，这里不抢。
  if (LEAK_HEAD.test(t)) return false
  if (!LEAK_CLOSE_TAIL.test(t)) return false
  const bare = t.replace(LEAK_TAGS_ALL, ' ').replace(/\s+/g, ' ').trim()
  // 剥完一个字都不剩：那是纯标签，走 tag-shape / tag-residual。
  if (bare.length === 0) return false
  // 剥完还有成段正文：标签只是尾巴，话本身说完了，放行。
  // 80 字是量出来的：全机 996 个会话 / 2392 个回合里，符合「标签落在结尾」的只有 1 条
  // 落在 80 字以内（真断点，剥完 9 字），其余都远超这个长度。
  if (bare.length > 80) return false
  if (PLAN_TAIL_HEADING.test(bare)) return false
  if (PLAN_TAIL_LINK.test(bare)) return false
  if (PLAN_TAIL_DONE.test(bare)) return false
  if (PLAN_TAIL_WAIT.test(bare)) return false
  return true
}

/**
 * 正文里裸露了本该被结构化的工具调用标签。
 *
 * 典型形态（真实会话 2026-11-17 20:34，ppll-polymarket 复核器那轮）：
 *   现在看 B 的复核器核心逻辑——这是最需要挑刺的地方。<parameter></thought>
 *   <bash> <parameter name="command">cd /Users/… </parameter>
 *   <description>读复核器核心判定流程</description> </bash>
 *   </thinking>
 *
 * 用户侧的现象最直观：正常时 DSH 把调用折成「已读取文件 / 执行了命令」卡片；
 * 一旦这些标签肉眼可见地印在正文里，就说明调用退化成了文本、前端认不出来，
 * 只能当 Markdown 摊开——DSH 那边同样收不到 tool_calls。
 *
 * 只认两个正常回答绝不会裸写的标记：`</parameter>` 与 `<parameter name=`。
 */
const EXPOSED_PARAM_ATTR = /<parameter\s+name\s*=/i
/** 裸露的调用闭合标签；单次可能只是在讨论代码，两次以上才是真摊开了。 */
const EXPOSED_PARAM_CLOSE = /<\/parameter>/gi
/** 半句里裸露的思考闭合标签；正常输出最多在开头带一个空壳。 */
const EXPOSED_THINK_CLOSE = /<\/\s*(?:thinking|thought)\s*>/gi

export function isExposedCallTag(text) {
  const raw = String(text ?? '')
  if (!raw) return false
  // 讨论代码时会把标签包在反引号或代码块里（我们排查插件时就常这么写）；
  // 先剥掉，只看真正裸写在正文里的那些。
  const t = raw.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
  // 带属性的参数标签，正常回答绝不会裸写；出现即说明调用变成了正文。
  if (EXPOSED_PARAM_ATTR.test(t)) return true
  if ((t.match(EXPOSED_PARAM_CLOSE)?.length ?? 0) >= 2) return true
  /**
   * 句子中间冒出思考闭合标签，而且剥掉标签后剩下的是一句过渡语。
   * 真实形态（会话 4b4eb158，用户截图）：
   *   「先看 section 当前结构（批量买入卡片部分）。</thinking> 表格改完且类型通过。现在改外层区块。」
   * 它交代了下一步就停，队列里的下一个任务立刻接管——这就是用户看到的「无缝换人」。
   * 只看「句中标签 + 过渡语」，长正文末尾带个尾巴标签不算。
   */
  if (/[^\n<>]\s*<\/\s*(?:thinking|thought)\s*>/i.test(t)) {
    const bare = t.replace(LEAK_TAGS_ALL, ' ').replace(/\s+/g, ' ').trim()
    if (isPlanTail(bare)) return true
  }
  // 两个以上闭合标签（哪怕都落在行首）同样说明思考块反复漏进正文。
  return (t.match(EXPOSED_THINK_CLOSE)?.length ?? 0) >= 2
}

/**
 * 思考回声：正文和思考几乎是同一段话。
 * 正常回复里，思考是独白、正文是给用户的话，两者内容不同；
 * 一旦正文整段等于（或几乎等于）思考，说明模型把内部独白当成回答了。
 */
const ECHO_MIN_CHARS = 200
const ECHO_MIN_RATIO = 0.85

export function isReasoningEcho(text, reasoning) {
  const t = String(text ?? '').replace(/\s+/g, '')
  const r = String(reasoning ?? '').replace(/\s+/g, '')
  if (t.length < ECHO_MIN_CHARS || r.length < ECHO_MIN_CHARS) return false
  const min = Math.min(t.length, r.length)
  const max = Math.max(t.length, r.length)
  if (min / max < ECHO_MIN_RATIO) return false
  return t === r || r.startsWith(t) || t.startsWith(r)
}

/** 从 session 上取事件数组，兼容不同内核版本。 */
export function readEvents(session) {
  if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents()
  if (session && Array.isArray(session.events)) return session.events
  return []
}

/**
 * 归纳某一轮的结构：最后一步有没有 tool-call、此前有没有、最后一步的文本/思考。
 * @param {Array} events 会话事件
 * @param {number} turn  回合号
 */
export function analyzeTurn(events, turn) {
  const steps = []

  for (const event of events) {
    const data = event?.data
    if (!data || data.turn !== turn) continue
    if (event.type !== 'assistant/message') continue

    const blocks = data.message?.content ?? []
    let hasToolCall = false
    let text = ''
    let reasoning = ''
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'tool-call') hasToolCall = true
      else if (b.type === 'text' && typeof b.text === 'string') text += b.text
      else if (b.type === 'reasoning' && typeof b.text === 'string') reasoning += b.text
    }
    steps.push({
      hasToolCall,
      text,
      reasoning,
      model: data.message?.source?.model ?? null,
    })
  }

  const last = steps[steps.length - 1] ?? null
  const prior = steps.slice(0, -1)
  return {
    turn,
    steps: steps.length,
    anyToolCall: steps.some((s) => s.hasToolCall),
    lastHasToolCall: last ? last.hasToolCall : false,
    /** 此前调过工具的比例：接近 1 说明这一轮在连着干活，中途停下来多半是断的。 */
    priorToolRatio: prior.length ? prior.filter((s) => s.hasToolCall).length / prior.length : 0,
    lastText: last ? last.text : '',
    lastReasoning: last ? last.reasoning : '',
    lastModel: last ? last.model : null,
  }
}

/**
 * 判断这一轮要不要补救。
 * @returns {{recover: boolean, why: string}}
 */
export function decideRecovery(analysis, config = {}) {
  const cfg = { ...DEFAULTS, ...config }

  if (!cfg.enabled) return { recover: false, why: 'disabled' }
  if (analysis.steps === 0) return { recover: false, why: 'no-message' }
  if (analysis.lastHasToolCall) return { recover: false, why: 'last-step-called-tool' }
  // 思考回声：正文和思考几乎是同一段话——模型把内部独白原样当成回答吐了出来。
  // 这条必须排在 no-tool-anywhere 前面：纯问答轮同样会这样坏，坏了就得救。
  if (isReasoningEcho(analysis.lastText, analysis.lastReasoning)) {
    return { recover: true, why: 'reasoning-echo' }
  }
  if (!analysis.anyToolCall) return { recover: false, why: 'no-tool-anywhere' }

  const text = (analysis.lastText ?? '').trim()
  const reasoning = (analysis.lastReasoning ?? '').trim()

  // A. 空回：一个字都没有。只思考不落字单独给一种话术。
  if (text.length === 0) {
    return reasoning.length > 0
      ? { recover: true, why: 'reasoning-only' }
      : { recover: true, why: 'blank-after-tool' }
  }

  // 浮华通道专用：干过活就必须交出「当前情况 / 做了哪些」两节，缺一则算中途退出。
  // 这两个供应商返回的工具调用经常不是标准格式（写成 <tool_call> 正文、或 tools
  // 被吞掉让模型自称没有工具），DSH 收不到 tool_calls 就当这一轮结束；文本形态
  // 千变万化抓不完，所以改判交付物。只有「确实在等人/等子代理」才放行。
  if (isFuhuaModel(analysis.lastModel) && !looksLikeWaiting(text) && !hasReportSections(text)) {
    return { recover: true, why: 'fuhua-no-report' }
  }

  // 思考泄漏：分四种，只看「有没有说完、有没有给出内容」。
  //   - 没闭合              → 说到一半，救；
  //   - 闭合了但后面没正文   → 只有复盘壳、没给你任何东西，救；
  //   - 闭合了又开新的没闭合 → 第二个思考块里写到一半就停，救；
  //   - 闭合了且后面有正文   → 正常输出（哪怕开头带了 thinking），不救。
  if (LEAK_HEAD.test(text)) {
    const closes = [...text.matchAll(LEAK_CLOSE_ALL)]
    if (closes.length === 0) return { recover: true, why: 'leak-unclosed' }
    const last = closes[closes.length - 1]
    const rest = text.slice(last.index + last[0].length).trim()
    if (rest.length === 0) return { recover: true, why: 'leak-no-body' }
    // 形如 `<thinking> </thinking>\n<thinking>\n……`（第二个块没关就停了）：
    // 前面那个空标签被当成「已经收了」，后面那段其实是第二个思考块的内容。
    const opened = rest.match(LEAK_OPEN_ONE)
    if (opened) {
      const after = rest.slice(opened.index + opened[0].length)
      const closer = new RegExp(`</\\s*${opened[1]}\\s*>`, 'i')
      if (!closer.test(after)) return { recover: true, why: 'leak-inner-unclosed' }
    }
    // 形如 `<thinking> </thinking>\n<parameter name="edit">`：闭合之后只剩一串残标签，
    // 一个字正文都没有——那是工具调用写坏了，不是「说完了」。
    if (RESIDUAL_TAGS_ONLY.test(rest)) return { recover: true, why: 'leak-residual-tag' }
    // 形如 `<thinking> </thinking>\n<parameter name="bash">\ncd /Users/...`：标签后面
    // 带正文，但整段是一个从参数标签起头的、没写完的调用。
    if (TAG_CALL_HEAD.test(rest)) return { recover: true, why: 'leak-call-head' }
    // 思考块后面跟的是一句过渡语（「先推送这一笔」），不是结论：同样是说到一半就停。
    if (analysis.steps >= 3 && (analysis.priorToolRatio ?? 0) >= 0.9 && isPlanTail(rest)) {
      return { recover: true, why: 'leak-plan-tail' }
    }
    // 闭合之后是一串反复改写的碎片（每行又挂着闭合标签），同上。
    if (isDegenerateLeak(rest)) return { recover: true, why: 'degenerate-leak' }
    return { recover: false, why: 'leak-has-body' }
  }

  // 退化重复泄漏：同一句被反复改写、每行挂着思考闭合标签（见 isDegenerateLeak）。
  // 这类文本靠重复把长度撑到远超 plan-tail 的 300 字上限，让那条判据整段失效。
  // 必须排在 LEAK_HEAD 之后：以 <analysis> 等开标签起头的完整复盘由上面的 leak-* 处理，
  // 不能被这条抢走（否则十几份压缩摘要会被误判成断点）。
  if (isDegenerateLeak(text)) return { recover: true, why: 'degenerate-leak' }
  if (isLeakTailStub(text)) return { recover: true, why: 'leak-tail-stub' }

  // 标签裸露：正文里摊着本该被结构化的调用标签。
  // 用户侧的现象是——正常时 DSH 把调用折成「已读取文件 / 执行了命令」卡片；
  // 一旦这些标签肉眼可见地印在正文里，就说明调用退化成了文本，DSH 收不到 tool_calls。
  // 这条比「缺两节」更早命中，也适用于任何通道；`</parameter>` 与 `<parameter name=`
  // 正常回答绝不会裸写（讨论代码时会用行内代码包起来）。
  // 必须排在下面那组精确判据之后，不能抢走 tag-residual / call-head。

  if (text.length > cfg.maxChars) return { recover: false, why: 'text-too-long' }

  // B. 残标签：整段只有一个标签，或标签开头且很短。
  if (TAG_ONLY.test(text)) return { recover: true, why: 'tag-shape' }
  // 整段就是一串带属性的残标签（`<parameter name="edit">`），没有正文。
  if (text.length <= cfg.fragmentMax && RESIDUAL_TAGS_ONLY.test(text)) {
    return { recover: true, why: 'tag-residual' }
  }
  if (text.length <= cfg.fragmentMax && JSON_CALL.test(text)) return { recover: true, why: 'json-tool-call' }
  // 整段从工具参数标签起头、后面带正文：`<parameter name="description" string="true">Check backend...`
  // 正常回复不会这样起头，这是把工具调用当正文写了。
  if (TAG_CALL_HEAD.test(text)) return { recover: true, why: 'call-head' }
  if (text.length <= cfg.fragmentMax && TAG_HEAD.test(text)) {
    return { recover: true, why: 'tag-head' }
  }

  // 标签裸露兜底：精确判据都没命中、正文里却摊着调用标签，同样算把调用写成了正文。
  // 放在长度上限之前，是因为用户截图里那种几万字的退化长文也要能抓住。
  if (isExposedCallTag(text)) return { recover: true, why: 'exposed-call-tag' }

  // C. 半句：停在逗号/分号/冒号/破折号上。
  if (text.length <= cfg.halfSentenceMax && HALF_TAIL.test(text)) {
    return { recover: true, why: 'half-sentence' }
  }

  // D. 过渡句收尾：整轮都在调工具，最后一步只留一句「现在/接着/最后 + 要做的事」，
  //    说完就停，动作没发生。正常汇报有标题/链接/完成态，正常等待有等待词，都不算。
  if (analysis.steps >= 3 && (analysis.priorToolRatio ?? 0) >= 0.9 && isPlanTail(text)) {
    return { recover: true, why: 'plan-tail' }
  }

  return { recover: false, why: 'looks-complete' }
}

/** 按断法选话术。 */
export function steerFor(why, cfg = DEFAULTS) {
  if (why === 'fuhua-no-report') return cfg.steerTextFuhua
  if (why === 'exposed-call-tag') return cfg.steerTextExposed
  if (why === 'reasoning-only') return cfg.steerTextReasoning
  if (why === 'blank-after-tool') return cfg.steerTextBlank
  if (why === 'half-sentence') return cfg.steerTextHalf
  if (why === 'plan-tail' || why === 'leak-plan-tail') return cfg.steerTextPlan
  if (why === 'degenerate-leak') return cfg.steerTextDegenerate
  if (why === 'leak-tail-stub') return cfg.steerTextLeakTail
  if (why === 'reasoning-echo') return cfg.steerTextEcho
  if (why === 'leak-unclosed' || why === 'leak-no-body' || why === 'leak-inner-unclosed') return cfg.steerTextLeak
  return cfg.steerText
}

/** 写一行日志，失败不影响主流程。 */
function appendLog(file, line) {
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${line}\n`)
  } catch {
    /* 日志写不进去就算了 */
  }
}

/**
 * 兼容旧内核：拿不到 createUserMessage 时手搓一个符合形状的用户消息。
 *
 * 必须有 id。会话日志按消息 id 认消息，缺 id 的 user/message 落盘当时不报错，
 * 但下次载入会抛 "session event at seq N lacks an identified message"，
 * 把整个会话打成 corrupt（历史再也打不开）。所以这里和内核 createMessage
 * 保持一致：role/content/source + randomUUID，不要塞 time（内核不写这个字段）。
 */
function fallbackUserMessage(spec) {
  return {
    role: 'user',
    content: spec.content,
    source: spec.source,
    id: randomUUID(),
  }
}

let cachedFactory = null
async function getCreateUserMessage() {
  if (cachedFactory) return cachedFactory
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    cachedFactory = mod.createUserMessage ?? fallbackUserMessage
  } catch {
    cachedFactory = fallbackUserMessage
  }
  return cachedFactory
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  /**
   * 记数的键必须带上会话 id。回合号是按会话各数各的，几乎每个会话第一轮都叫
   * turn=1；只按回合号记，A 会话用掉的次数会算到 B 会话头上，B 一进来就被判
   * 「已经补过了」「上次补话没效果」而直接停手。
   */
  const turnKey = (agent, turn) => `${agent?.session?.id ?? '-'}#${turn}`
  /** 每轮已经补救了几次 */
  const spent = new Map()
  /** 每轮补救后的日志长度，用来判断上一次补救有没有生效 */
  const probe = new Map()

  const log = (msg) => ctx.logger?.info?.(`[${name}] ${msg}`)
  const warn = (msg) => ctx.logger?.warn?.(`[${name}] ${msg}`)
  /** 所有落盘统一走这里：debug:false 时一行都不写（含 give-up / steer-failed）。 */
  const writeLog = (line) => { if (cfg.debug) appendLog(cfg.logFile, line) }

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    const key = turnKey(agent, turn)
    const used = spent.get(key) ?? 0
    if (used >= cfg.maxContinuations) return

    const events = readEvents(agent?.session)
    const analysis = analyzeTurn(events, turn)
    const decision = decideRecovery(analysis, cfg)
    const text = (analysis.lastText ?? '').trim()

    // 埋点：每判一次都落一行，事后能倒查「断在哪、是哪种形态、哪个模型」。
    writeLog([
      new Date().toISOString(),
      `turn=${turn}`,
      `step=${analysis.steps}`,
      `why=${decision.why}`,
      `recover=${decision.recover}`,
      `model=${analysis.lastModel ?? '-'}`,
      `used=${used}`,
      `text=${JSON.stringify(text.slice(0, 80))}`,
    ].join(' | '))

    // 上一次补救之后如果又是同样情形，说明模型不听，别再烧了
    if (probe.has(key)) {
      const at = probe.get(key)
      probe.delete(key)
      if (decision.recover && events.length <= at) {
        spent.set(key, cfg.maxContinuations)
        warn(`turn ${turn}: 上一次补救没有产生新内容，停止补救`)
        writeLog(`${new Date().toISOString()} | turn=${turn} | give-up | 补救无新增内容`)
        return
      }
    }

    if (!decision.recover) return

    try {
      const createUserMessage = await getCreateUserMessage()
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: steerFor(decision.why, cfg) }],
        source: PLUGIN_SOURCE,
      }))
      spent.set(key, used + 1)
      probe.set(key, events.length)
      log(`turn ${turn}: 命中 ${decision.why}，第 ${used + 1} 次补救`)
    } catch (error) {
      warn(`turn ${turn}: 补救失败 ${String(error)}`)
      writeLog(`${new Date().toISOString()} | turn=${turn} | steer-failed | ${String(error)}`)
    }
  })

  /** 回合真正结束后清账，避免 Map 无限增长。 */
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/end') {
      const key = `${session?.id ?? '-'}#${event.data?.turn}`
      spent.delete(key)
      probe.delete(key)
    }
  })

  log(`已加载（每轮最多补救 ${cfg.maxContinuations} 次，日志 ${cfg.logFile}）`)
}