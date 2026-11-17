import test from 'node:test'
import assert from 'node:assert/strict'
import { decideRecovery, steerFor, analyzeTurn, apply, DEFAULTS, name } from '../index.js'

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
  assert.equal(DEFAULTS.maxContinuations, 4)
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
  assert.equal(why('现在跑门禁并逐文件审 diff。', { steps: 3, priorToolRatio: 1 }), 'looks-complete')
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

test('过渡句收尾用「动作没发生」那句补话', () => {
  assert.equal(steerFor('plan-tail', DEFAULTS), DEFAULTS.steerTextPlan)
  assert.equal(steerFor('leak-plan-tail', DEFAULTS), DEFAULTS.steerTextPlan)
})

test('recover 标志与 why 一致', () => {
  const recoverWhy = new Set([
    'blank-after-tool', 'reasoning-only', 'leak-unclosed', 'leak-no-body',
    'leak-inner-unclosed', 'leak-residual-tag', 'leak-call-head',
    'tag-shape', 'tag-residual', 'call-head',
    'json-tool-call', 'tag-head', 'half-sentence', 'plan-tail', 'leak-plan-tail',
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
