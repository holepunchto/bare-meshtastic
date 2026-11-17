const test = require('brittle')
const meshtastic = require('.')

const settings = [...sub(2, [...Buffer.alloc(32, 0xab)]), ...sub(3, text('beacon'))]
const channel = [...tag(1, 0), ...varint(1), ...sub(2, settings)]

test('textMessage', (t) => {
  t.alike(
    bytes(meshtastic.textMessage('hi', { id: 0x01020304 })),
    [
      0x0a, 0x14, 0x15, 0xff, 0xff, 0xff, 0xff, 0x22, 0x06, 0x08, 0x01, 0x12, 0x02, 0x68, 0x69,
      0x35, 0x04, 0x03, 0x02, 0x01, 0x48, 0x03
    ]
  )

  const direct = meshtastic.textMessage('x', {
    id: 1,
    to: 0xdeadbeef,
    wantAck: true,
    hopLimit: 7
  })

  t.ok(direct.includes(Buffer.from([0x50, 0x01])), 'want_ack')
  t.ok(direct.includes(Buffer.from([0x15, 0xef, 0xbe, 0xad, 0xde])), 'to')
  t.ok(direct.includes(Buffer.from([0x48, 0x07])), 'hop_limit')
})

test('textMessage throws over the payload ceiling', (t) => {
  t.execution(() => meshtastic.textMessage('a'.repeat(meshtastic.MAX_PAYLOAD)))
  t.exception(() => meshtastic.textMessage('a'.repeat(meshtastic.MAX_PAYLOAD + 1)), /max is 233/)
})

test('wantConfig', (t) => {
  t.alike(bytes(meshtastic.wantConfig(0x2a)), [0x18, 0x2a])
})

test('getChannel asks our own node for index + 1', (t) => {
  const asked = meshtastic.getChannel(1, 0xdeadbeef)

  t.ok(asked.includes(Buffer.from([0x08, 0x06])), 'portnum = ADMIN_APP')
  t.ok(asked.includes(Buffer.from([0x15, 0xef, 0xbe, 0xad, 0xde])), 'addressed to our node')
  t.ok(asked.includes(Buffer.from([0x18, 0x01])), 'want_response')
  t.ok(asked.includes(Buffer.from([0x12, 0x02, 0x08, 0x02])), 'get_channel_request')
})

test('setChannel writes psk, name and passkey', (t) => {
  const psk = Buffer.alloc(32, 0xab)
  const passkey = Buffer.from([1, 2, 3, 4])
  const written = meshtastic.setChannel(1, { name: 'beacon', psk }, passkey, 1)

  t.ok(written.includes(Buffer.from([...sub(33, channel), ...sub(101, [...passkey])])))
})

test('setChannel respects the slot sizes', (t) => {
  const passkey = Buffer.from([1])

  t.execution(() =>
    meshtastic.setChannel(
      1,
      { name: 'b', psk: Buffer.alloc(meshtastic.CHANNEL_PSK_SIZE) },
      passkey,
      1
    )
  )
  t.exception(
    () => meshtastic.setChannel(1, { name: 'b', psk: Buffer.alloc(33) }, passkey, 1),
    /max is 32/
  )
  t.exception(
    () => meshtastic.setChannel(1, { name: 'a'.repeat(13), psk: Buffer.alloc(32) }, passkey, 1),
    /over 12/
  )
})

test('decode a mesh packet', (t) => {
  const data = [...tag(1, 0), ...varint(1), ...sub(2, text('yo'))]
  const packet = [
    ...tag(1, 5),
    ...fixed32(0x11223344),
    ...tag(2, 5),
    ...fixed32(0xffffffff),
    ...sub(4, data),
    ...tag(6, 5),
    ...fixed32(0x99887766),
    ...tag(8, 5),
    ...float(-7.25),
    ...tag(9, 0),
    ...varint(2),
    ...tag(12, 0),
    ...varint(-95),
    ...tag(15, 0),
    ...varint(3)
  ]

  const frame = meshtastic.decode(Buffer.from([...tag(1, 0), ...varint(7), ...sub(2, packet)]))

  t.is(frame.type, 'packet')
  t.is(frame.packet.from, 0x11223344)
  t.is(frame.packet.to, meshtastic.BROADCAST)
  t.is(frame.packet.snr, -7.25)
  t.is(frame.packet.rssi, -95, 'a negative int32')
  t.is(frame.packet.hopLimit, 2)
  t.is(frame.packet.hopStart, 3)
  t.is(Buffer.from(frame.packet.data.payload).toString(), 'yo')
})

test('decode myInfo', (t) => {
  const frame = meshtastic.decode(Buffer.from(sub(3, [...tag(1, 0), ...varint(0xdeadbeef)])))

  t.is(frame.type, 'myInfo')
  t.is(meshtastic.nodeId(frame.nodeNum), '!deadbeef')
})

test('decode nodeInfo', (t) => {
  const user = [...sub(1, text('!abc')), ...sub(2, text('Tony Node')), ...sub(3, text('TNY'))]
  const frame = meshtastic.decode(
    Buffer.from(sub(4, [...tag(1, 0), ...varint(42), ...sub(2, user), ...tag(9, 0), ...varint(2)]))
  )

  t.is(frame.node.num, 42)
  t.is(frame.node.user.longName, 'Tony Node')
  t.is(frame.node.user.shortName, 'TNY')
  t.is(frame.node.hopsAway, 2)
})

test('decode configComplete', (t) => {
  const frame = meshtastic.decode(Buffer.from([...tag(7, 0), ...varint(9)]))

  t.is(frame.type, 'configComplete')
  t.is(frame.configId, 9)
})

test('decode the LoRa config', (t) => {
  const lora = [
    ...tag(1, 0),
    ...varint(1),
    ...tag(2, 0),
    ...varint(0),
    ...tag(7, 0),
    ...varint(3),
    ...tag(8, 0),
    ...varint(3)
  ]

  t.alike(meshtastic.decode(Buffer.from(sub(5, sub(6, lora)))).lora, {
    region: 'EU_868',
    preset: 'LONG_FAST',
    hopLimit: 3
  })
})

test('a radio off a preset is not given a preset name', (t) => {
  const custom = [
    ...tag(1, 0),
    ...varint(0),
    ...tag(2, 0),
    ...varint(6),
    ...tag(7, 0),
    ...varint(1)
  ]

  t.is(meshtastic.decode(Buffer.from(sub(5, sub(6, custom)))).lora.preset, 'CUSTOM')
})

test('regions are named, and an unknown one is not invented', (t) => {
  const region = (value) =>
    meshtastic.decode(Buffer.from(sub(5, sub(6, [...tag(7, 0), ...varint(value)])))).lora.region

  t.is(region(37), 'ITU2_125CM', 'the last one this version knows')
  t.is(region(99), 'UNKNOWN')
})

test('a config section that is not LoRa is left alone', (t) => {
  const frame = meshtastic.decode(Buffer.from(sub(5, sub(1, [...tag(1, 0), ...varint(2)]))))

  t.is(frame.type, null)
  t.is(frame.lora, null)
})

test('decode a channel slot', (t) => {
  const frame = meshtastic.decode(
    Buffer.from(sub(10, [...channel, ...tag(3, 0), ...varint(meshtastic.CHANNEL_PRIMARY)]))
  )

  t.is(frame.type, 'channel')
  t.is(frame.channel.name, 'beacon')
  t.is(frame.channel.psk.length, meshtastic.CHANNEL_PSK_SIZE)
  t.is(frame.channel.role, meshtastic.CHANNEL_PRIMARY)
})

test('unknown fields of every wire type are skipped', (t) => {
  const frame = meshtastic.decode(
    Buffer.from([
      ...tag(99, 0),
      ...varint(1234),
      ...sub(98, [1, 2, 3, 4, 5]),
      ...tag(97, 5),
      ...fixed32(0xcafebabe),
      ...tag(96, 1),
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      ...tag(7, 0),
      ...varint(9)
    ])
  )

  t.is(frame.configId, 9, 'a field after them still parses')
})

test('an encrypted packet is flagged, never guessed at', (t) => {
  const frame = meshtastic.decode(
    Buffer.from(sub(2, [...tag(1, 5), ...fixed32(1), ...sub(5, [9, 9, 9])]))
  )

  t.is(frame.packet.encrypted, true)
  t.is(frame.packet.data, null)
})

test('truncated frames throw instead of returning junk', (t) => {
  t.exception(() => meshtastic.decode(Buffer.from([0x12, 0x0a, 0x01, 0x02])), /truncated/)
  t.exception(() => meshtastic.decode(Buffer.from([0xc9, 0x06, 0x01])), /truncated/)
  t.exception(() => meshtastic.decode(Buffer.from([0x08, 0xff])), /truncated/)
})

test('a client drives the conversation over whatever it is given', (t) => {
  const written = []
  const client = new meshtastic.Client({
    read: () => {},
    write: (frame) => written.push(frame)
  })

  client.sync()
  t.is(written.length, 1, 'sync asks for the node database')

  client.push(Buffer.from(sub(3, [...tag(1, 0), ...varint(0xdeadbeef)])))
  t.is(client.id, '!deadbeef', 'myInfo lands')

  client.push(Buffer.from(sub(10, [...channel, ...tag(3, 0), ...varint(1)])))
  t.is(client.channels.get(1).name, 'beacon', 'channel slots land')

  client.destroy()
})

// An encoder that shares no code with the one under test, so a bug in the
// codec's own Writer cannot hide behind the same bug in a helper.

function varint(value) {
  let v = BigInt(value)
  if (v < 0n) v += 1n << 64n

  const out = []
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  out.push(Number(v))
  return out
}

function tag(field, wire) {
  return varint((field << 3) | wire)
}
function sub(field, body) {
  return [...tag(field, 2), ...varint(body.length), ...body]
}
function text(value) {
  return [...Buffer.from(value)]
}
function bytes(message) {
  return Array.from(message)
}

function fixed32(value) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value >>> 0)
  return [...b]
}

function float(value) {
  const b = Buffer.alloc(4)
  b.writeFloatLE(value)
  return [...b]
}
