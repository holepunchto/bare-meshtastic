const test = require('brittle')
const meshtastic = require('..')
const {
  varint,
  tag,
  sub,
  text,
  bytes,
  sfixed32,
  fixed32,
  float,
  hopLimit,
  WANT_ACK,
  channel
} = require('./helpers')

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

  t.ok(direct.includes(Buffer.from(WANT_ACK)), 'want_ack')
  t.ok(direct.includes(Buffer.from([0x15, 0xef, 0xbe, 0xad, 0xde])), 'to')
  t.ok(direct.includes(Buffer.from(hopLimit(7))), 'hop_limit')
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

test('decode a routing ack', (t) => {
  const ok = meshtastic.decodeRouting(Buffer.from([]))
  t.is(ok.delivered, true, 'error_reason omitted means NONE')
  t.is(ok.reason, 'NONE')

  const failed = meshtastic.decodeRouting(Buffer.from([...tag(3, 0), ...varint(5)]))
  t.is(failed.delivered, false)
  t.is(failed.reason, 'MAX_RETRANSMIT')

  const unknown = meshtastic.decodeRouting(Buffer.from([...tag(3, 0), ...varint(200)]))
  t.is(unknown.reason, 'UNKNOWN', 'a reason this version does not name')
})

test('decode a position', (t) => {
  const position = meshtastic.decodePosition(
    Buffer.from([
      ...tag(1, 5),
      ...sfixed32(488566000),
      ...tag(2, 5),
      ...sfixed32(23522000),
      ...tag(3, 0),
      ...varint(35),
      ...tag(4, 5),
      ...fixed32(1700000000)
    ])
  )

  t.is(position.latitude, 48.8566)
  t.is(position.longitude, 2.3522)
  t.is(position.altitude, 35)
  t.is(position.time, 1700000000)
})

test('a position south and west comes back negative', (t) => {
  const position = meshtastic.decodePosition(
    Buffer.from([...tag(1, 5), ...sfixed32(-338688000), ...tag(2, 5), ...sfixed32(-704440000)])
  )

  t.is(position.latitude, -33.8688)
  t.is(position.longitude, -70.444)
})

test('decode telemetry', (t) => {
  const metrics = [
    ...tag(1, 0),
    ...varint(82),
    ...tag(2, 5),
    ...float(3.98),
    ...tag(3, 5),
    ...float(4.5),
    ...tag(5, 0),
    ...varint(3600)
  ]

  const telemetry = meshtastic.decodeTelemetry(
    Buffer.from([...tag(1, 5), ...fixed32(1700000000), ...sub(2, metrics)])
  )

  t.is(telemetry.battery, 82)
  t.is(Math.round(telemetry.voltage * 100) / 100, 3.98)
  t.is(telemetry.channelUtilization, 4.5)
  t.is(telemetry.uptime, 3600)
  t.is(telemetry.airUtilTx, null, 'a metric the radio did not send')
})

test('decode a node announcing itself over the air', (t) => {
  const user = meshtastic.decodeUserPayload(
    Buffer.from([...sub(1, text('!abc')), ...sub(2, text('LoRa1')), ...sub(3, text('LR1'))])
  )

  t.is(user.longName, 'LoRa1')
  t.is(user.shortName, 'LR1')
})

test('a packet carries the id it is answering', (t) => {
  const data = [...tag(1, 0), ...varint(meshtastic.PORT_ROUTING), ...tag(6, 5), ...fixed32(0x1234)]
  const frame = meshtastic.decode(
    Buffer.from(sub(2, [...tag(1, 5), ...fixed32(1), ...sub(4, data)]))
  )

  t.is(frame.packet.data.requestId, 0x1234)
})

test('a message whose every field is default still decodes', (t) => {
  // proto3 omits defaults, so the field carrying such a message is absent
  t.alike(meshtastic.decodeRouting(null), { error: 0, reason: 'NONE', delivered: true })
  t.is(meshtastic.decodePosition(null).latitude, null)
  t.is(meshtastic.decodeTelemetry(null).battery, null)
  t.is(meshtastic.decodeUserPayload(null).longName, null)
  t.is(meshtastic.decodeAdmin(null).passkey, null)
})

test('a hop limit of zero is kept, not read as absent', (t) => {
  // adminMessage asks for 0: do not relay, local link only
  t.absent(meshtastic.getChannel(1, 0xdeadbeef).includes(Buffer.from(hopLimit(3))))
})

test('a real hop limit still lands', (t) => {
  t.ok(meshtastic.packet(1, Buffer.from('x'), { hopLimit: 7 }).includes(Buffer.from(hopLimit(7))))
})

test('the entry exposes everything the protocol has', (t) => {
  const protocol = require('../lib/protocol')
  const missing = Object.keys(protocol).filter((key) => key in meshtastic === false)

  t.alike(missing, [], 'index.js must re-export every name')
})

test('every truncated fixed-width field throws', (t) => {
  // MeshPacket.from is a fixed32; FromRadio.id next to it is a varint
  t.exception(
    () => meshtastic.decode(Buffer.from(sub(2, [...tag(1, 5), 1, 2]))),
    /truncated fixed32/
  )
  t.exception(
    () => meshtastic.decodePosition(Buffer.from([...tag(1, 5), 1, 2])),
    /truncated sfixed32/
  )
  t.exception(() => meshtastic.decode(Buffer.from(sub(2, [...tag(8, 5), 1, 2]))), /truncated float/)
})

test('a varint that never ends throws rather than spinning', (t) => {
  const runaway = [...tag(1, 0), ...Array(12).fill(0xff)]

  t.exception(() => meshtastic.decode(Buffer.from(runaway)), /varint too long/)
})

test('a wire type that does not exist throws', (t) => {
  t.exception(() => meshtastic.decode(Buffer.from([...tag(99, 3), 1])), /unknown wire type 3/)
})

test('a preset this version does not name is not invented', (t) => {
  const lora = [...tag(1, 0), ...varint(1), ...tag(2, 0), ...varint(99)]

  t.is(meshtastic.decode(Buffer.from(sub(5, sub(6, lora)))).lora.preset, 'UNKNOWN')
})

test('a node report carries its signal strength', (t) => {
  const node = [...tag(1, 0), ...varint(42), ...tag(4, 5), ...float(-7.25)]

  t.is(meshtastic.decode(Buffer.from(sub(4, node))).node.snr, -7.25)
})

test('telemetry carries the air time a radio spent talking', (t) => {
  const metrics = [...tag(1, 0), ...varint(82), ...tag(4, 5), ...float(1.5)]

  t.is(meshtastic.decodeTelemetry(Buffer.from(sub(2, metrics))).airUtilTx, 1.5)
})

test('an admin reply carries the passkey a write has to echo', (t) => {
  const admin = meshtastic.decodeAdmin(Buffer.from(sub(101, [1, 2, 3, 4])))

  t.alike(Array.from(admin.passkey), [1, 2, 3, 4])
})

test('a truncated negative varint throws rather than guessing', (t) => {
  // MeshPacket.rx_rssi is an int32, so a negative one is ten bytes on the wire
  const cut = [...tag(12, 0), ...varint(-95).slice(0, 4)]

  t.exception(() => meshtastic.decode(Buffer.from(sub(2, cut))), /truncated varint/)
})

test('a packet id is never zero, even when the draw is', (t) => {
  const random = Math.random
  t.teardown(() => (Math.random = random))

  Math.random = () => 0

  t.is(meshtastic.randomId(), 1, 'zero means "no id" to the mesh, so it is not one')
})
