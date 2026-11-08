import test from 'node:test'
import assert from 'node:assert/strict'
import { decideRecovery, steerFor, analyzeTurn, DEFAULTS, name } from '../index.js'

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
  // 闭合后有真正的正文：说完了，不打扰
  assert.equal(why('<thinking> </thinking>\n## 当前情况\n活干完了，测试全绿。'), 'leak-has-body')
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

test('recover 标志与 why 一致', () => {
  const recoverWhy = new Set([
    'blank-after-tool', 'reasoning-only', 'leak-unclosed', 'leak-no-body',
    'leak-inner-unclosed', 'tag-shape', 'json-tool-call', 'tag-head', 'half-sentence',
  ])
  const samples = [
    '', '<analysis>x', '<analysis>x</analysis>',
    '<thinking> </thinking>\n<thinking>\n等等：看它的签名。',
    '<thinking> </thinking>\n## 结论\n说完了。',
    '<ask_user_question">', '{"tool_calls": []}', '<bash>\nls', '现在先去，', '说完了。',
  ]
  for (const s of samples) {
    const d = decideRecovery(a(s), {})
    assert.equal(d.recover, recoverWhy.has(d.why), `文本 ${JSON.stringify(s.slice(0, 30))} 判为 ${d.why}`)
  }
})

test('四类思考泄漏共用同一句补话', () => {
  for (const w of ['leak-unclosed', 'leak-no-body', 'leak-inner-unclosed']) {
    assert.equal(steerFor(w, DEFAULTS), DEFAULTS.steerTextLeak)
  }
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
