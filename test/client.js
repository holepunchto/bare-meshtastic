const test = require('brittle')
const meshtastic = require('..')
const {
  varint,
  tag,
  sub,
  text,
  wantConfigId,
  sfixed32,
  fixed32,
  asks,
  WANT_ACK,
  channel
} = require('./helpers')

test('a delivered ack reaches the caller', (t) => {
  t.plan(2)

  const id = 0x1234
  using client = new meshtastic.Client({ read: () => {}, write: () => {} })

  client.on('ack', (ack) => {
    t.is(ack.delivered, true, 'success is all-default, so it has no payload')
    t.is(ack.id, id)
  })

  const data = [...tag(1, 0), ...varint(meshtastic.PORT_ROUTING), ...tag(6, 5), ...fixed32(id)]
  client.push(Buffer.from(sub(2, [...tag(1, 5), ...fixed32(1), ...sub(4, data)])))
})

test('an undefined option does not erase a default', (t) => {
  t.plan(1)

  using client = new meshtastic.Client({ read: () => {}, write: (frame) => t.ok(asks(frame)) })

  client.sendPacket(1, Buffer.from('hi'), { to: 7, wantAck: undefined })
})

test('an explicit false still turns an option off', (t) => {
  t.plan(1)

  using client = new meshtastic.Client({ read: () => {}, write: (frame) => t.absent(asks(frame)) })

  client.sendPacket(1, Buffer.from('hi'), { wantAck: false })
})

test('a configComplete before any sync is ignored', (t) => {
  t.plan(1)

  using client = new meshtastic.Client({ read: () => {}, write: () => {} })

  client.on('ready', () => t.fail('a leftover frame resolved a sync that never happened'))
  client.push(Buffer.from([...tag(7, 0), ...varint(0)]))

  t.pass('nothing fired')
})

test('a client is disposable', (t) => {
  let closed = 0

  {
    using client = new meshtastic.Client({ read: () => {}, write: () => {}, close: () => closed++ })
    client.sync()
  }

  t.is(closed, 1, 'leaving the block let the radio go')
})

test('a second sync makes the first one stale', (t) => {
  t.plan(1)

  const asked = []
  using client = new meshtastic.Client({
    read: () => {},
    write: (frame) => asked.push(wantConfigId(frame))
  })

  client.sync()
  client.sync()
  client.on('ready', () => t.pass('only the answer to the second sync finishes it'))

  client.push(Buffer.from([...tag(7, 0), ...varint(asked[0])]))
  client.push(Buffer.from([...tag(7, 0), ...varint(asked[1])]))
})

test('a client can send on any port, not just text', (t) => {
  const sent = []
  using client = new meshtastic.Client({ read: () => {}, write: (frame) => sent.push(frame) })

  client.send('hi')
  client.sendPacket(meshtastic.PORT_POSITION, Buffer.from([1, 2, 3]), { wantAck: false })

  t.ok(sent[0].includes(Buffer.from([0x08, meshtastic.PORT_TEXT_MESSAGE])), 'text port')
  t.ok(sent[1].includes(Buffer.from([0x08, meshtastic.PORT_POSITION])), 'position port')
  t.ok(sent[0].includes(Buffer.from(WANT_ACK)), 'text asks for an ack by default')
  t.absent(sent[1].includes(Buffer.from(WANT_ACK)), 'wantAck can be turned off')
})

test('a client routes each packet to its own event', (t) => {
  t.plan(5)

  using client = new meshtastic.Client({ read: () => {}, write: () => {} })

  function deliver(portnum, payload, opts = {}) {
    const data = [
      ...tag(1, 0),
      ...varint(portnum),
      ...sub(2, payload),
      ...(opts.requestId ? [...tag(6, 5), ...fixed32(opts.requestId)] : [])
    ]

    const packet = [
      ...tag(1, 5),
      ...fixed32(0x11223344),
      ...tag(2, 5),
      ...fixed32(0xffffffff),
      ...sub(4, data)
    ]

    client.push(Buffer.from(sub(2, packet)))
  }

  client.on('message', (m) => {
    t.is(m.text, 'hello')
    t.is(m.from, '!11223344')
  })

  client.on('ack', (a) => {
    t.is(a.id, 0x4321)
    t.is(a.delivered, false)
  })

  client.on('position', (p) => t.is(p.latitude, 48.8566))

  deliver(meshtastic.PORT_TEXT_MESSAGE, text('hello'))
  deliver(meshtastic.PORT_ROUTING, [...tag(3, 0), ...varint(3)], { requestId: 0x4321 })
  deliver(meshtastic.PORT_POSITION, [...tag(1, 5), ...sfixed32(488566000)])
})

test('a client drops the echo of its own packet', (t) => {
  t.plan(1)

  using client = new meshtastic.Client({ read: () => {}, write: () => {} })

  client.push(Buffer.from(sub(3, [...tag(1, 0), ...varint(0x11223344)])))
  client.on('message', () => t.fail('our own packet came back as a message'))

  const data = [...tag(1, 0), ...varint(meshtastic.PORT_TEXT_MESSAGE), ...sub(2, text('mine'))]
  client.push(Buffer.from(sub(2, [...tag(1, 5), ...fixed32(0x11223344), ...sub(4, data)])))

  t.pass('no message emitted')
})

test('a client drives the conversation over whatever it is given', (t) => {
  const written = []
  using client = new meshtastic.Client({
    read: () => {},
    write: (frame) => written.push(frame)
  })

  client.sync()
  t.is(written.length, 1, 'sync asks for the node database')

  client.push(Buffer.from(sub(3, [...tag(1, 0), ...varint(0xdeadbeef)])))
  t.is(client.id, '!deadbeef', 'myInfo lands')

  client.push(Buffer.from(sub(10, [...channel, ...tag(3, 0), ...varint(1)])))
  t.is(client.channels.get(1).name, 'beacon', 'channel slots land')
})
