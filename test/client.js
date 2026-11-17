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

test('sync gives up out loud if the database never finishes', (t) => {
  t.plan(1)

  // not `using`: the block ends before the timer fires, and disposing cancels it
  const client = new meshtastic.Client({ read: () => {}, write: () => {}, syncTimeout: 1 })

  client.on('error', (err) => {
    t.ok(/node database/.test(err.message))
    client.destroy()
  })

  client.sync()
})

test('the drain loop stops on an empty read and re-arms on a notify', (t) => {
  let reads = 0

  using client = new meshtastic.Client({ read: () => reads++, write: () => {} })

  client.notify()
  t.is(reads, 1, 'one read in flight')

  client.notify()
  t.is(reads, 1, 'a second notify does not start a second read')

  client.push(null)
  t.is(reads, 2, 'the queued notify fires once the queue drains')

  client.push(null)
  t.is(reads, 2, 'and nothing is left pending')
})

test('a frame that cannot be decoded is reported, not swallowed', (t) => {
  t.plan(1)

  using client = new meshtastic.Client({ read: () => {}, write: () => {} })

  client.on('error', (err) => t.ok(/truncated/.test(err.message)))
  client.push(Buffer.from([0x12, 0x0a, 0x01, 0x02]))
})

test('a config frame lands on the client', (t) => {
  const lora = [...tag(1, 0), ...varint(1), ...tag(7, 0), ...varint(3)]

  using client = new meshtastic.Client({ read: () => {}, write: () => {} })

  client.push(Buffer.from(sub(5, sub(6, lora))))
  t.is(client.config.region, 'EU_868')
})

test('a node from the database is remembered by name', (t) => {
  const user = [...sub(2, text('Tony Node')), ...sub(3, text('TNY'))]

  using client = new meshtastic.Client({ read: () => {}, write: () => {} })

  client.push(Buffer.from(sub(4, [...tag(1, 0), ...varint(42), ...sub(2, user)])))
  t.is(client.nameOf(42), 'TNY')
  t.is(client.nameOf(43), '!0000002b', 'a node never heard of falls back to its id')
})

test('an admin reply reaches the caller', (t) => {
  t.plan(1)

  using client = new meshtastic.Client({ read: () => {}, write: () => {} })

  client.on('admin', (admin) => t.is(admin.channel.name, 'beacon'))

  const payload = [...sub(2, channel)]
  const data = [...tag(1, 0), ...varint(meshtastic.PORT_ADMIN), ...sub(2, payload)]
  client.push(Buffer.from(sub(2, [...tag(1, 5), ...fixed32(1), ...sub(4, data)])))
})

test('telemetry reaches the caller', (t) => {
  t.plan(2)

  using client = new meshtastic.Client({ read: () => {}, write: () => {} })

  client.on('telemetry', (telemetry) => {
    t.is(telemetry.battery, 82)
    t.is(telemetry.from, '!11223344')
  })

  const metrics = [...tag(1, 0), ...varint(82)]
  const payload = [...sub(2, metrics)]
  const data = [...tag(1, 0), ...varint(meshtastic.PORT_TELEMETRY), ...sub(2, payload)]
  client.push(Buffer.from(sub(2, [...tag(1, 5), ...fixed32(0x11223344), ...sub(4, data)])))
})

test('a node announcing itself over the air is remembered', (t) => {
  t.plan(2)

  using client = new meshtastic.Client({ read: () => {}, write: () => {} })

  client.on('node', (node) => t.is(node.user.shortName, 'LR1'))

  const user = [...sub(2, text('LoRa1')), ...sub(3, text('LR1'))]
  const data = [...tag(1, 0), ...varint(meshtastic.PORT_NODEINFO), ...sub(2, user)]
  client.push(Buffer.from(sub(2, [...tag(1, 5), ...fixed32(0x11223344), ...sub(4, data)])))

  t.is(client.nameOf(0x11223344), 'LR1', 'and used as the name from then on')
})

test('channel reads and writes go to our own node', (t) => {
  const sent = []

  using client = new meshtastic.Client({ read: () => {}, write: (frame) => sent.push(frame) })

  client.push(Buffer.from(sub(3, [...tag(1, 0), ...varint(0xdeadbeef)])))
  client.getChannel(1)
  client.setChannel(1, { name: 'beacon', psk: Buffer.alloc(32) }, Buffer.from([1]))

  const toUs = Buffer.from([...tag(2, 5), ...fixed32(0xdeadbeef)])
  t.ok(sent[0].includes(toUs), 'the read is addressed to us')
  t.ok(sent[1].includes(toUs), 'and so is the write')
})

test('a destroyed client is deaf and dumb', (t) => {
  let reads = 0
  const client = new meshtastic.Client({ read: () => reads++, write: () => {} })

  client.destroy()
  client.notify()
  client.push(Buffer.from(sub(3, [...tag(1, 0), ...varint(7)])))

  t.is(reads, 0, 'no read was issued')
  t.is(client.nodeNum, 0, 'and nothing was taken from the frame')
})

test('a frame this version does not model is ignored, not fatal', (t) => {
  using client = new meshtastic.Client({ read: () => {}, write: () => {} })

  client.on('error', () => t.fail('an unmodelled frame must not be an error'))
  client.push(Buffer.from([...tag(21, 0), ...varint(1)]))

  t.pass('skipped quietly')
})

test('an empty text message arrives as an empty string', (t) => {
  t.plan(2)

  using client = new meshtastic.Client({ read: () => {}, write: () => {} })

  client.on('message', (message) => {
    t.is(message.text, '')
    t.is(message.hops, 0, 'no hop_start means no hops counted')
  })

  const data = [...tag(1, 0), ...varint(meshtastic.PORT_TEXT_MESSAGE)]
  client.push(Buffer.from(sub(2, [...tag(1, 5), ...fixed32(0x11223344), ...sub(4, data)])))
})
