const test = require('brittle')
const meshtastic = require('..')
const {
  varint,
  tag,
  sub,
  text,
  fixed32,
  sfixed32,
  wantConfigId,
  asks,
  channel,
  FakeRadio,
  settle
} = require('./helpers')

test('a client reads what the radio sends it', async (t) => {
  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  radio.push(Buffer.from(sub(3, [...tag(1, 0), ...varint(0xdeadbeef)])))
  await settle()

  t.is(client.id, '!deadbeef')
})

test('a client writes to the radio it was given', async (t) => {
  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  client.send('hi')
  await settle()

  t.is(radio.written.length, 1)
  t.ok(asks(radio.written[0]), 'text asks for an ack by default')
})

test('a write reports backpressure', async (t) => {
  const keepsUp = new FakeRadio()
  using quick = new meshtastic.Client(keepsUp)

  t.ok(quick.send('x'), 'a radio that keeps up leaves room')

  // never finishes a write, and room for less than one frame
  const stalls = new FakeRadio({ slow: true, highWaterMark: 1 })
  using stalled = new meshtastic.Client(stalls)

  t.absent(stalled.send('x'), 'a radio that falls behind says so instead of queueing')

  await settle()
})

test('an undefined option does not erase a default', async (t) => {
  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  client.sendPacket(1, Buffer.from('hi'), { to: 7, wantAck: undefined })
  await settle()

  t.ok(asks(radio.written[0]))
})

test('an explicit false still turns an option off', async (t) => {
  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  client.sendPacket(1, Buffer.from('hi'), { wantAck: false })
  await settle()

  t.absent(asks(radio.written[0]))
})

test('channel reads and writes go to our own node', async (t) => {
  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  radio.push(Buffer.from(sub(3, [...tag(1, 0), ...varint(0xdeadbeef)])))
  await settle()

  client.getChannel(1)
  client.setChannel(1, { name: 'beacon', psk: Buffer.alloc(32) }, Buffer.from([1]))
  await settle()

  const toUs = Buffer.from([...tag(2, 5), ...fixed32(0xdeadbeef)])
  t.ok(radio.written[0].includes(toUs), 'the read is addressed to us')
  t.ok(radio.written[1].includes(toUs), 'and so is the write')
})

test('a delivered ack reaches the caller', async (t) => {
  t.plan(2)

  const id = 0x1234
  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  client.on('ack', (ack) => {
    t.is(ack.delivered, true, 'success is all-default, so it has no payload')
    t.is(ack.id, id)
  })

  radio.push(Buffer.from(packet(meshtastic.PORT_ROUTING, [], { requestId: id })))
  await settle()
})

test('a client routes each packet to its own event', async (t) => {
  t.plan(4)

  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  client.on('message', (m) => {
    t.is(m.text, 'hello')
    t.is(m.from, '!11223344')
  })
  client.on('position', (p) => t.is(p.latitude, 48.8566))
  client.on('telemetry', (telemetry) => t.is(telemetry.battery, 82))

  radio.push(Buffer.from(packet(meshtastic.PORT_TEXT_MESSAGE, text('hello'))))
  radio.push(Buffer.from(packet(meshtastic.PORT_POSITION, [...tag(1, 5), ...sfixed32(488566000)])))
  radio.push(Buffer.from(packet(meshtastic.PORT_TELEMETRY, sub(2, [...tag(1, 0), ...varint(82)]))))
  await settle()
})

test('an admin reply reaches the caller', async (t) => {
  t.plan(1)

  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  client.on('admin', (admin) => t.is(admin.channel.name, 'beacon'))

  radio.push(Buffer.from(packet(meshtastic.PORT_ADMIN, sub(2, channel))))
  await settle()
})

test('a node announcing itself over the air keeps what the database knew', async (t) => {
  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  const known = [...sub(2, text('Tony Node')), ...sub(3, text('TNY'))]
  radio.push(
    Buffer.from(
      sub(4, [...tag(1, 0), ...varint(0x11223344), ...sub(2, known), ...tag(9, 0), ...varint(2)])
    )
  )
  await settle()
  t.is(client.nodes.get(0x11223344).hopsAway, 2)

  radio.push(Buffer.from(packet(meshtastic.PORT_NODEINFO, sub(2, text('LoRa1')))))
  await settle()

  t.is(client.nodes.get(0x11223344).user.longName, 'LoRa1', 'the fresher name wins')
  t.is(client.nodes.get(0x11223344).hopsAway, 2, 'and the hop count is not thrown away')
})

test('a client drops the echo of its own packet', async (t) => {
  t.plan(1)

  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  client.on('message', () => t.fail('our own packet came back as a message'))

  radio.push(Buffer.from(sub(3, [...tag(1, 0), ...varint(0x11223344)])))
  await settle()
  radio.push(Buffer.from(packet(meshtastic.PORT_TEXT_MESSAGE, text('mine'))))
  await settle()

  t.pass('no message emitted')
})

test('an empty text message arrives as an empty string', async (t) => {
  t.plan(2)

  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  client.on('message', (message) => {
    t.is(message.text, '')
    t.is(message.hops, 0, 'no hop_start means no hops counted')
  })

  radio.push(Buffer.from(packet(meshtastic.PORT_TEXT_MESSAGE)))
  await settle()
})

test('a config frame lands on the client', async (t) => {
  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  const lora = [...tag(1, 0), ...varint(1), ...tag(7, 0), ...varint(3)]
  radio.push(Buffer.from(sub(5, sub(6, lora))))
  await settle()

  t.is(client.config.region, 'EU_868')
})

test('a node never heard of falls back to its id', (t) => {
  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  t.is(client.nameOf(43), '!0000002b')
})

test('a second sync makes the first one stale', async (t) => {
  t.plan(1)

  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  client.sync()
  client.sync()
  await settle()

  client.on('ready', () => t.pass('only the answer to the second sync finishes it'))

  for (const frame of radio.written) {
    radio.push(Buffer.from([...tag(7, 0), ...varint(wantConfigId(frame))]))
  }
  await settle()
})

test('a configComplete before any sync is ignored', async (t) => {
  t.plan(1)

  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  client.on('ready', () => t.fail('a leftover frame resolved a sync that never happened'))

  radio.push(Buffer.from([...tag(7, 0), ...varint(0)]))
  await settle()

  t.pass('nothing fired')
})

test('sync gives up out loud if the database never finishes', (t) => {
  t.plan(1)

  const client = new meshtastic.Client(new FakeRadio(), { syncTimeout: 1 })

  client.on('error', (err) => {
    t.ok(/node database/.test(err.message))
    client.destroy()
  })

  client.sync()
})

test('a frame that cannot be decoded is reported, not swallowed', async (t) => {
  t.plan(1)

  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  client.on('error', (err) => t.ok(/truncated/.test(err.message)))

  radio.push(Buffer.from([0x12, 0x0a, 0x01, 0x02]))
  await settle()
})

test('a frame this version does not model is ignored, not fatal', async (t) => {
  t.plan(1)

  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  client.on('error', () => t.fail('an unmodelled frame must not be an error'))

  radio.push(Buffer.from([...tag(21, 0), ...varint(1)]))
  await settle()

  t.pass('skipped quietly')
})

test('a destroyed client lets the radio go', async (t) => {
  const radio = new FakeRadio()
  const client = new meshtastic.Client(radio)

  client.destroy()
  client.destroy()
  await settle()

  t.ok(radio.destroyed, 'the stream was destroyed, once')
})

test('a client is disposable', async (t) => {
  const radio = new FakeRadio()

  {
    using client = new meshtastic.Client(radio)
    client.sync()
  }

  await settle()

  t.ok(radio.destroyed, 'leaving the block let the radio go')
})

test('a channel slot lands on the client', async (t) => {
  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  radio.push(
    Buffer.from(sub(10, [...channel, ...tag(3, 0), ...varint(meshtastic.CHANNEL_PRIMARY)]))
  )
  await settle()

  t.is(client.channels.get(1).name, 'beacon')
})

test('a closed stream is reported', async (t) => {
  t.plan(1)

  const radio = new FakeRadio()
  const client = new meshtastic.Client(radio)

  client.on('close', () => t.pass('the caller learns the link is gone'))
  client.destroy()
  await settle()
})

function packet(portnum, payload = [], opts = {}) {
  const data = [
    ...tag(1, 0),
    ...varint(portnum),
    ...(payload.length ? sub(2, payload) : []),
    ...(opts.requestId ? [...tag(6, 5), ...fixed32(opts.requestId)] : [])
  ]

  return sub(2, [
    ...tag(1, 5),
    ...fixed32(opts.from ?? 0x11223344),
    ...tag(2, 5),
    ...fixed32(0xffffffff),
    ...sub(4, data)
  ])
}

test('an encrypted packet is not mistaken for one we can read', async (t) => {
  t.plan(1)

  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  client.on('message', () => t.fail('there was nothing to read'))

  const encrypted = [...tag(1, 5), ...fixed32(0x11223344), ...sub(5, [9, 9, 9])]
  radio.push(Buffer.from(sub(2, encrypted)))
  await settle()

  t.pass('skipped')
})

test('a relayed message counts the hops it took', async (t) => {
  t.plan(1)

  const radio = new FakeRadio()
  using client = new meshtastic.Client(radio)

  client.on('message', (message) => t.is(message.hops, 2))

  const data = [...tag(1, 0), ...varint(meshtastic.PORT_TEXT_MESSAGE), ...sub(2, text('relayed'))]
  const relayed = [
    ...tag(1, 5),
    ...fixed32(0x11223344),
    ...sub(4, data),
    ...tag(9, 0),
    ...varint(1),
    ...tag(15, 0),
    ...varint(3)
  ]

  radio.push(Buffer.from(sub(2, relayed)))
  await settle()
})
