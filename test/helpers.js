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

// ToRadio { want_config_id }: one tag byte, then the id as a varint.
function wantConfigId(frame) {
  let value = 0
  let scale = 1

  for (let i = 1; i < frame.length; i++) {
    value += (frame[i] & 0x7f) * scale
    if ((frame[i] & 0x80) === 0) break
    scale *= 128
  }

  return value
}

function sfixed32(value) {
  const b = Buffer.alloc(4)
  b.writeInt32LE(value)
  return [...b]
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

// MeshPacket.want_ack and MeshPacket.hop_limit, built rather than spelled out.
const WANT_ACK = [...tag(10, 0), ...varint(1)]

function hopLimit(hops) {
  return [...tag(9, 0), ...varint(hops)]
}

function asks(frame) {
  return frame.includes(Buffer.from(WANT_ACK))
}

const settings = [...sub(2, [...Buffer.alloc(32, 0xab)]), ...sub(3, text('beacon'))]
const channel = [...tag(1, 0), ...varint(1), ...sub(2, settings)]

module.exports = {
  varint,
  tag,
  sub,
  text,
  bytes,
  wantConfigId,
  sfixed32,
  fixed32,
  float,
  hopLimit,
  asks,
  WANT_ACK,
  settings,
  channel
}
