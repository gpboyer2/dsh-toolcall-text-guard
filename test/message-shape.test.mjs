import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/**
 * 兜底消息的形状必须和内核 createUserMessage 一致。
 *
 * 这条曾经出过事：兜底手搓 { role, content, source, time }，缺 id。
 * 落盘当时不报错，但内核载入会话时按消息 id 认消息，缺 id 会抛
 * "session event at seq N lacks an identified message"，整个会话判为 corrupt，
 * 历史再也打不开（本机 1018 个会话里坏了 72 个，都是这条路走出来的）。
 * 所以这里锁死：投递出去的补救消息必须带非空 id。
 */

function makeCtx() {
  const handlers = new Map()
  const ctx = {
    on: (event, fn) => handlers.set(event, fn),
    logger: { info() {}, warn() {} },
  }
  return { handlers, ctx }
}

/** 一个「调过工具、最后一步只吐复盘壳」的回合，会被判定为需要补话。 */
const EVENTS = [
  { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'tool-call' }] } } },
  {
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '<analysis>梳理完了</analysis>' }] } },
  },
]

test('补话消息必须带非空 id（缺 id 会让整个会话在下次载入时判为损坏）', async () => {
  const { handlers, ctx } = makeCtx()
  apply(ctx, { debug: false })

  let delivered
  const agent = {
    session: { id: 'session-shape', snapshotEvents: () => EVENTS },
    steer: (message) => { delivered = message },
  }

  await handlers.get('agent/turn-stopping')({ agent, turn: 1 })

  assert.ok(delivered, '这一轮应当补话')
  assert.equal(typeof delivered.id, 'string', 'id 必须是字符串')
  assert.notEqual(delivered.id, '', 'id 不能是空串')
  assert.equal(delivered.role, 'user')
  assert.equal(delivered.source.kind, 'plugin:toolcall-text-guard')
  assert.ok(Array.isArray(delivered.content) && delivered.content.length > 0)
  assert.equal('time' in delivered, false, '内核消息不写 time，兜底也不要写')
})

test('每次补话的 id 都不同（避免重放时被当成同一条消息）', async () => {
  const { handlers, ctx } = makeCtx()
  apply(ctx, { debug: false })

  const ids = []
  const mk = (id) => ({
    session: { id, snapshotEvents: () => EVENTS },
    steer: (message) => { ids.push(message.id) },
  })

  // 用两个会话各触发一次：同一会话重复触发会撞上「补救无新增内容」而停手
  await handlers.get('agent/turn-stopping')({ agent: mk('session-shape-a'), turn: 1 })
  await handlers.get('agent/turn-stopping')({ agent: mk('session-shape-b'), turn: 1 })

  assert.equal(ids.length, 2)
  assert.notEqual(ids[0], ids[1])
})
