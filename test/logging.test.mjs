import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

/** 抓住 apply 注册的 handler，不启动真实 DSH。 */
function makeCtx() {
  const handlers = new Map()
  const ctx = {
    on: (event, fn) => handlers.set(event, fn),
    logger: { info() {}, warn() {} },
  }
  return { handlers, ctx }
}

/** 一个「调过工具、最后一步只有复盘壳」的回合，会被判定为需要补话。 */
const EVENTS = [
  { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'tool-call' }] } } },
  {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '<analysis>梳理完了</analysis>' }] } },
  },
]

const makeAgent = (overrides = {}) => ({
  session: { snapshotEvents: () => EVENTS },
  steer() {},
  ...overrides,
})

const fire = (handlers, agent, turn = 1) =>
  handlers.get('agent/turn-stopping')({ agent, turn })

function tempLog(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'guard.log')
}

test('debug:false 时主埋点与 give-up 都不落盘', async (t) => {
  const logFile = tempLog(t)
  const { handlers, ctx } = makeCtx()
  apply(ctx, { debug: false, logFile })
  const agent = makeAgent()
  await fire(handlers, agent) // 命中 leak-no-body，走正常补救
  await fire(handlers, agent) // 同一回合再判，进入 give-up 分支
  assert.equal(fs.existsSync(logFile), false, 'debug:false 不应产生任何日志文件')
})

test('debug:false 时 steer-failed 也不落盘', async (t) => {
  const logFile = tempLog(t)
  const { handlers, ctx } = makeCtx()
  apply(ctx, { debug: false, logFile })
  const agent = makeAgent({ steer() { throw new Error('steer exploded') } })
  await fire(handlers, agent)
  assert.equal(fs.existsSync(logFile), false, '补救失败路径也必须遵守 debug 开关')
})

test('debug:true 时确实会落盘（对照，证明日志机制没被改坏）', async (t) => {
  const logFile = tempLog(t)
  const { handlers, ctx } = makeCtx()
  apply(ctx, { debug: true, logFile })
  await fire(handlers, makeAgent())
  assert.equal(fs.existsSync(logFile), true)
  assert.match(fs.readFileSync(logFile, 'utf8'), /why=leak-no-body \| recover=true/)
})
