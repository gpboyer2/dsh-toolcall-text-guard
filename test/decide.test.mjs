import test from 'node:test'
import assert from 'node:assert/strict'
import { decideRecovery, steerFor, analyzeTurn, apply, DEFAULTS, name, isFuhuaModel, hasReportSections, looksLikeWaiting } from '../index.js'

/** 造一个「这一轮调过工具、但最后一步只吐文本」的分析结果。 */
const a = (text, extra = {}) => ({
  steps: 5,
  lastHasToolCall: false,
  anyToolCall: true,
  lastText: text,
  lastReasoning: '',
  ...extra,
})

const why = (text, extra) => decideRecovery(a(text, extra), {}).why

test('导出的插件名与默认配置', () => {
  assert.equal(name, 'toolcall-text-guard')
  assert.equal(DEFAULTS.maxContinuations, 6)
  assert.equal(DEFAULTS.enabled, true)
})

test('前置门槛：不算断的情形', () => {
  assert.equal(decideRecovery(a('随便', { steps: 0 }), {}).why, 'no-message')
  assert.equal(decideRecovery(a('随便'), { enabled: false }).why, 'disabled')
  assert.equal(decideRecovery(a('随便', { lastHasToolCall: true }), {}).why, 'last-step-called-tool')
  assert.equal(decideRecovery(a('随便', { anyToolCall: false }), {}).why, 'no-tool-anywhere')
})

test('空回：一个字都没有 / 只有思考', () => {
  assert.equal(why(''), 'blank-after-tool')
  assert.equal(why('   \n  '), 'blank-after-tool')
  assert.equal(why('', { lastReasoning: '我还在想' }), 'reasoning-only')
})

test('浮华通道识别', () => {
  assert.equal(isFuhuaModel('fuhua/deepseek-v4.1-flash'), true)
  assert.equal(isFuhuaModel('fuhua-mac/deepseek-v4.1-flash'), true)
  assert.equal(isFuhuaModel('group/cherish-ai'), false)
  assert.equal(isFuhuaModel('group/vigorously-ai'), false)
  assert.equal(isFuhuaModel(null), false)
})

test('交付两节识别', () => {
  assert.equal(hasReportSections('## 当前情况\n已好'), false)
  assert.equal(hasReportSections('## 当前情况\n已改完。\n## 做了哪些\n- 抽函数'), true)
  assert.equal(hasReportSections('**当前情况**：完成\n**做了哪些**：改了配置'), true)
  assert.equal(hasReportSections('> 当前情况：完成\n> 做了哪些：改配置'), true)
  assert.equal(hasReportSections('只有当前情况，没有下半节'), false)
})

test('浮华通道：干过活却没交两节，判中途退出', () => {
  const f = 'fuhua-mac/deepseek-v4.1-flash'
  // 真实断例一：只写一句过渡就停
  assert.equal(why('先确认两件事：PAXG 的行情数据是否齐全（已确认 5m 有 1.75 万根），以及会不会被最小下单量卡住。', { lastModel: f }), 'fuhua-no-report')
  // 真实断例二：工具调用写成 XML 正文
  assert.equal(why('<tool_call>\n{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call>', { lastModel: f }), 'fuhua-no-report')
  // 真实断例三：思考片段漏进正文
  assert.equal(why(' 的步骤，看是否与断点相关。\n\n这是关键实验。让我做。', { lastModel: f }), 'fuhua-no-report')
  // 真实断例四：自称没有工具可用
  assert.equal(why('当前会话没有提供可执行命令的工具，所以我无法直接查看。', { lastModel: 'fuhua/deepseek-v4.1-flash' }), 'fuhua-no-report')
  // 两节齐全 -> 放行
  assert.equal(why('## 当前情况\n\n已改完并验证，测试全绿。\n\n## 做了哪些\n\n- 抽了公共函数\n- 重跑了测试', { lastModel: f }), 'looks-complete')
  // 等待态放行：等子代理
  assert.equal(why('已经派了 3 个子代理，等任一结束腾出空位后继续。', { lastModel: f }), 'looks-complete')
  // 等待态放行：把话头递给用户
  assert.equal(why('你要我把上限调到 300 字吗？', { lastModel: f }), 'looks-complete')
})

test('浮华判据不影响其他通道', () => {
  const text = '先确认两件事：PAXG 的行情数据是否齐全。'
  assert.equal(why(text, { lastModel: 'group/cherish-ai', priorToolRatio: 1 }), 'plan-tail')
  assert.equal(why(text, { lastModel: null, priorToolRatio: 1 }), 'plan-tail')
})

test('浮华通道用「补齐两节」那句补话', () => {
  const msg = steerFor('fuhua-no-report', DEFAULTS)
  assert.match(msg, /当前情况/)
  assert.match(msg, /做了哪些/)
})

test('思考泄漏：四种形态', () => {
  // 从头到尾没闭合
  assert.equal(why('<analysis>\n让我按时间顺序梳理这次对话'), 'leak-unclosed')
  // 闭合了，但后面没有任何正文
  assert.equal(why('<analysis>梳理完了</analysis>'), 'leak-no-body')
  // 前面一个空标签闭合后，又开了一个思考块却没关：真实断例
  assert.equal(
    why('<thinking> </thinking>\n<thinking>\n等等：这个函数为什么返回 null？看它的签名。'),
    'leak-inner-unclosed',
  )
  // 闭合之后只剩一串残标签，一个字正文都没有：真实断例，救
  assert.equal(
    why('<thinking> </thinking>\n<parameter name="edit">'),
    'leak-residual-tag',
  )
  assert.equal(why('<thinking> </thinking>\n</parameter>'), 'leak-residual-tag')
  // 闭合后跟的是「从参数标签起头、带正文却没写完」的调用：真实断例，救
  assert.equal(
    why('<thinking> </thinking>\n<parameter name="bash">\ncd /Users/peng/Desktop/'),
    'leak-call-head',
  )
  // 闭合后有真正的正文：说完了，不打扰
  assert.equal(why('<thinking> </thinking>\n## 当前情况\n活干完了，测试全绿。'), 'leak-has-body')
  // 残标签后面跟的是正常正文（不是工具调用形态），不打扰
  assert.equal(why('<thinking> </thinking>\n<parameter name="edit">这是正文'), 'leak-call-head')
  // 内层闭合且后面有正文：同样不打扰
  assert.equal(why('<thinking> </thinking>\n<thinking>想清楚了</thinking>\n结论如下。'), 'leak-has-body')
})

test('长度上限只作用于非思考泄漏的普通长文', () => {
  const long = '结论：' + '很长的正文。'.repeat(2000)
  assert.equal(why(long), 'text-too-long')
  // 但思考泄漏不论多长都要判，不能被长度上限挡掉
  assert.equal(why('<analysis>' + '复盘'.repeat(9000) + '</analysis>'), 'leak-no-body')
})

test('残标签 / JSON 调用残片', () => {
  assert.equal(why('<ask_user_question">'), 'tag-shape')
  // 整段就是一串带属性的残标签，没有半个字正文
  assert.equal(why('<parameter name="edit">'), 'tag-residual')
  assert.equal(why('<parameter name="edit">\n</parameter>'), 'tag-residual')
  assert.equal(why('<function=foo>'), 'tag-residual')
  // 从参数标签起头、后面带正文：真实断例，正常回复不会这样起头
  assert.equal(why('<parameter name="edit">这是正文'), 'call-head')
  assert.equal(
    why('<parameter name="description" string="true">Check backend process and health'),
    'call-head',
  )
  assert.equal(why('<parameter name="bash">\ncd /Users/peng/Desktop/'), 'call-head')
  assert.equal(why('{"tool_calls": [{"name": "bash"}]}'), 'json-tool-call')
  assert.equal(why('<bash>\nls -la'), 'tag-head')
  // 长正文里只是提到这个字段名（比如模型在解释调用格式），不该被当成残片
  const prose = '下面解释一下格式：' + '模型有时会写出 '.repeat(60)
    + '{"tool_calls": [...]} 这样的结构，注意并不需要真的发起调用。'
  assert.equal(why(prose), 'looks-complete')
})

test('半句截断', () => {
  assert.equal(why('现在先去查一下，'), 'half-sentence')
})

test('正常说完', () => {
  assert.equal(why('修好并验证完了，下面按约定汇报。'), 'looks-complete')
  assert.equal(why('## 当前情况\n钩子已经能拦住违规提交。\n\n## 做了哪些\n查清了根因。'), 'looks-complete')
})

test('过渡句收尾：说了下一步就停，动作没发生', () => {
  // 三条都是真实断例（session-33dec29b 同一会话连断三次）
  const plan = (text) => why(text, { steps: 18, priorToolRatio: 1 })
  assert.equal(plan('收敛后端到端仍通过。现在按你的要求批判性审一遍 diff，重点看有没有隐患、bug、遗漏。'), 'plan-tail')
  assert.equal(plan('主号复测通过（覆盖 2128→2123；结论不变）。现在跑门禁并逐文件审 diff。'), 'plan-tail')
  assert.equal(plan('至此四条分支全部验证到。最后统一文件权限并复核 client 改动。'), 'plan-tail')
  assert.equal(plan('继续修复剩余项：\n4) §2.3 兜底A 的 sed -i\n5) §2.1.1 症状修正\n6) Ant 国内镜像'), 'plan-tail')

  // 正常汇报：有章节标题
  assert.equal(plan('## 当前情况\n已经改完并推送。\n\n## 做了哪些\n补了判据。'), 'looks-complete')
  // 正常交付：带链接
  assert.equal(plan('交付完成：[demo.zip](https://x/y.zip) 已生成，可直接导入。'), 'looks-complete')
  // 正常等待
  assert.equal(plan('等待子代理交付中；收到结果后立刻开始逐文件验收。'), 'looks-complete')
  assert.equal(plan('基线已记录。等两个子代理回报后，我会按关键词全文扫描。'), 'looks-complete')
  assert.equal(plan('当前活跃：G3, G6, G7, G8（满额 4 个）。静待进展。'), 'looks-complete')
  // 在等用户点头
  assert.equal(plan('这个方向你看可以我就开始动手。'), 'looks-complete')
  // 正常提问：结尾在问用户
  assert.equal(plan('门禁跑完了。要我现在提交吗？'), 'looks-complete')
  // 只有动词、没有「什么时候去做」的承诺
  assert.equal(plan('这条改动很干净。'), 'looks-complete')

  // 结构条件不满足时不判：步数太少、此前不是全程调工具
  // 门槛是 3 步：短轮次同样会「说完下一步就停」（session-a2bf67e8 的 turn 3 只有 3 步），
  // 但 1–2 步的极短轮多半是单发问答，仍不判。
  assert.equal(why('现在跑门禁并逐文件审 diff。', { steps: 2, priorToolRatio: 1 }), 'looks-complete')
  assert.equal(why('现在跑门禁并逐文件审 diff。', { steps: 18, priorToolRatio: 0.5 }), 'looks-complete')
})

test('思考块后面跟过渡语，同样算说到一半', () => {
  const plan = (text) => why(text, { steps: 17, priorToolRatio: 1 })
  // 真实断例：`<thought>` 块后只跟了一句「先推送这一笔」
  assert.equal(
    plan('<thought>\nThe hooks ran and all passed.\n</thought>\n\n第一笔提交通过（五道门禁全过）。先推送这一笔。'),
    'leak-plan-tail',
  )
  // 思考块后面是完整汇报：不打扰
  assert.equal(plan('<thinking>   </thinking>\n## 当前情况\n重画完成，验收通过。'), 'leak-has-body')
})

test('思考回声：正文被整段写成思考', () => {
  const long = '用户恼了，他要的是一套能照着做的完整方案，不是再拆机制。' + '前面几轮一直在拆机制、给对比表。'.repeat(12)
  const echo = (t, r) => why(t, { steps: 1, anyToolCall: false, lastText: t, lastReasoning: r })

  // 真实断例：正文与思考完全相同，且这一轮没调过工具
  assert.equal(echo(long, long), 'reasoning-echo')
  // 正文是思考的前缀（少个尾巴）
  assert.equal(echo(long, long + '补一句结束语。'), 'reasoning-echo')

  // 正常回复：正文和思考内容不同（没触发回声，仍走原来的门槛）
  assert.equal(echo('## 常小娥怎么玩\n第 1 回合就按技能，场上只留一个人。', long), 'no-tool-anywhere')
  // 太短的不比（避免把一句「好的」误判）
  assert.equal(echo('好的，我明白了。', '好的，我明白了。'), 'no-tool-anywhere')
  // 长度差太多：正文只是思考的一小段
  assert.equal(echo(long.slice(0, 60), long), 'no-tool-anywhere')
})

test('思考回声用「别复述分析过程」那句补话', () => {
  assert.equal(steerFor('reasoning-echo', DEFAULTS), DEFAULTS.steerTextEcho)
})

test('过渡句收尾用「动作没发生」那句补话', () => {
  assert.equal(steerFor('plan-tail', DEFAULTS), DEFAULTS.steerTextPlan)
  assert.equal(steerFor('leak-plan-tail', DEFAULTS), DEFAULTS.steerTextPlan)
})

test('recover 标志与 why 一致', () => {
  const recoverWhy = new Set([
    'blank-after-tool', 'reasoning-only', 'leak-unclosed', 'leak-no-body',
    'leak-inner-unclosed', 'leak-residual-tag', 'leak-call-head',
    'tag-shape', 'tag-residual', 'call-head',
    'json-tool-call', 'tag-head', 'half-sentence', 'plan-tail', 'leak-plan-tail', 'reasoning-echo',
  ])
  const samples = [
    '', '<analysis>x', '<analysis>x</analysis>',
    '<thinking> </thinking>\n<thinking>\n等等：看它的签名。',
    '<thinking> </thinking>\n<parameter name="edit">',
    '<parameter name="edit">',
    '<thinking> </thinking>\n<parameter name="edit">这是正文',
    '<thinking> </thinking>\n## 结论\n说完了。',
    '<ask_user_question">', '{"tool_calls": []}', '<bash>\nls', '现在先去，', '说完了。',
  ]
  for (const s of samples) {
    const d = decideRecovery(a(s), {})
    assert.equal(d.recover, recoverWhy.has(d.why), `文本 ${JSON.stringify(s.slice(0, 30))} 判为 ${d.why}`)
  }
})

test('四类思考泄漏共用同一句补话；残标签改用工具调用那句', () => {
  for (const w of ['leak-unclosed', 'leak-no-body', 'leak-inner-unclosed']) {
    assert.equal(steerFor(w, DEFAULTS), DEFAULTS.steerTextLeak)
  }
  // 残标签是「工具调用写坏了」，用工具调用那句更对症
  assert.equal(steerFor('leak-residual-tag', DEFAULTS), DEFAULTS.steerText)
  assert.equal(steerFor('tag-residual', DEFAULTS), DEFAULTS.steerText)
  // 带正文的残调用同理，也是「工具调用写坏了」
  assert.equal(steerFor('leak-call-head', DEFAULTS), DEFAULTS.steerText)
  assert.equal(steerFor('call-head', DEFAULTS), DEFAULTS.steerText)
  assert.equal(steerFor('half-sentence', DEFAULTS), DEFAULTS.steerTextHalf)
  assert.equal(steerFor('blank-after-tool', DEFAULTS), DEFAULTS.steerTextBlank)
  assert.equal(steerFor('reasoning-only', DEFAULTS), DEFAULTS.steerTextReasoning)
  // 对外导出的函数允许省略配置，避免外部调用方拿到 undefined 报错
  assert.equal(steerFor('half-sentence'), DEFAULTS.steerTextHalf)
  assert.equal(steerFor('leak-inner-unclosed'), DEFAULTS.steerTextLeak)
})

test('analyzeTurn 只统计本轮，并识别最后一步有没有工具调用', () => {
  const msg = (turn, blocks) => ({
    type: 'assistant/message',
    data: { turn, message: { content: blocks } },
  })
  const events = [
    msg(1, [{ type: 'tool-call' }]),
    msg(2, [{ type: 'text', text: '别的回合' }]),
    msg(1, [{ type: 'text', text: '最后一步' }]),
  ]
  const r = analyzeTurn(events, 1)
  assert.equal(r.steps, 2)
  assert.equal(r.anyToolCall, true)
  assert.equal(r.lastHasToolCall, false)
  assert.equal(r.lastText, '最后一步')
})

// 会话 324afd75（ppll-polymarket）第 2 轮第 38 步的真实断点：748 字 / 18 行，
// 17 个行首 `</thinking>`，同一句「现在改 trader-picker.js」被反复改写、越写越短。
// 这类重复把长度撑过 plan-tail 的 300 字上限，让那条判据整段失效——必须单独兜住。
const DEGENERATE_TEXT = [
  '现在改 trader-picker.js 的两个抓取函数：排行榜改为 cursor 翻页、拆开 v2 返回的外层结构；已结算持仓改用 `/v2/positions?status=CLOSED`。',
  '</thinking>现在改 `trader-picker.js` 的两个抓取函数。先验证 v2 positions 的排序参数取值，避免猜。',
  '</thinking>现在改 `trader-picker.js`。先验证 v2 positions 的排序参数取值，不要靠猜。',
  '</thinking>现在改 `trader-picker.js`。先确认 v2 positions 的排序取值，别猜。',
  '</thinking>先确认 v2 positions 的排序取值，再改 `trader-picker.js`。',
  '</thinking>先确认 v2 positions 排序取值。',
  '</thinking>先确认排序取值。',
  '</thinking>先确认。',
  '</thinking>先测 v2 positions 的排序参数取值。',
  '</thinking>先测排序参数。',
  '</thinking>先测排序。',
  '</thinking>先测。',
  '先测。',
  '</thinking>',
].join('\n')

const withTool = (turn, text) => [
  { type: 'assistant/message', data: { turn, message: { content: [{ type: 'tool-call' }] } } },
  { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } },
]

test('退化重复泄漏：同一句反复改写、行首挂闭合标签，判 degenerate-leak', () => {
  const r = decideRecovery(analyzeTurn(withTool(2, DEGENERATE_TEXT), 2))
  assert.equal(r.recover, true)
  assert.equal(r.why, 'degenerate-leak')
  assert.equal(steerFor('degenerate-leak', DEFAULTS), DEFAULTS.steerTextDegenerate)
})

test('退化重复泄漏：正常单次泄漏、正常汇报都不许误伤', () => {
  // 单行闭合标签 + 完整正文：保持旧行为（放行），只有两行以上才判退化
  const leakedOnce = '</thinking>\n现在改好了，测试全过。'
  assert.equal(decideRecovery(analyzeTurn(withTool(1, leakedOnce), 1)).recover, false)
  // 正常汇报：带标题、多点内容
  const normal = '## 当前情况\n\n改完了。\n\n## 做了哪些\n\n- 把 v1 迁到 v2\n- 补了两个测试\n\n## 其他\n\n无。'
  assert.equal(decideRecovery(analyzeTurn(withTool(1, normal), 1)).recover, false)
  // 只有一行闭合标签，不足两行：不判
  // 正文只剩一个孤立标签：仍由既有 tag-shape 兜住，不被新判据抢走
  assert.equal(decideRecovery(analyzeTurn(withTool(1, '</thinking>\n'), 1)).why, 'tag-shape')
})

// 会话 72688503（ppll-polymarket）第 1 轮第 20 步的真实断点：
// 正文只有「查一下依赖装在哪。」后面拖着两个 </thinking>，剥掉标签只剩 9 个字，
// 整轮 20 步都在调工具，这一步既没发起调用也没给结论，plan-tail 却认不出
// （那句里没有「现在/先」这类前缀词）。
test('收尾挂标签：短句后面拖闭合标签，判 leak-tail-stub', () => {
  const text = '查一下依赖装在哪。</thinking></thinking>\n\n'
  const r = decideRecovery(analyzeTurn(withTool(1, text), 1))
  assert.equal(r.recover, true)
  assert.equal(r.why, 'leak-tail-stub')
  assert.equal(steerFor('leak-tail-stub', DEFAULTS), DEFAULTS.steerTextLeakTail)
})

test('收尾挂标签：有实质正文、纯标签、开标签起头都不许误伤', () => {
  // 标签只是尾巴，话本身说完了（剥完远超 140 字）
  const longBody = '已经把 v1 全部迁到 v2：余额、赎回、对账、跟单信号源、钱包筛选、回测脚本共 11 处调用点都改完并逐个实测，'
    + '响应结构、分页方式、字段名三处差异都按官方 openapi 对齐，回归全绿。</thinking>'
  assert.equal(decideRecovery(analyzeTurn(withTool(1, longBody), 1)).why, 'looks-complete')
  // 剥完一个字不剩：交给 tag-shape / tag-residual
  assert.equal(decideRecovery(analyzeTurn(withTool(1, '</thinking></thinking>'), 1)).why, 'tag-residual')
  // 以开标签起头的整段复盘：交给 leak-* 按「闭合后有没有正文」处理
  // 闭合后没有正文：仍由既有 leak-no-body 兜住，不被新判据抢走
  const opened = '<analysis>查完了。</analysis>'
  assert.equal(decideRecovery(analyzeTurn(withTool(1, opened), 1)).why, 'leak-no-body')
  // 标签在句中、后面还有正文：不是收尾挂标签
  const midTag = '查一下依赖装在哪。</thinking>现在去查。'
  assert.equal(decideRecovery(analyzeTurn(withTool(1, midTag), 1)).recover, false)
})
