const test = require('brittle')
const meshtastic = require('..')
const { FakeRadio, settle, varint, tag, sub } = require('./helpers')

const START1 = 0x94
const START2 = 0xc3
const MAX_FRAME = 512

test('a message split across chunks arrives whole', async (t) => {
  const { messages, source } = reading(t)
  const bytes = frame('hello')

  source.push(bytes.subarray(0, 3))
  await settle()

  t.alike(messages, [], 'half a header is not a message')

  source.push(bytes.subarray(3))
  await settle()

  t.alike(messages, [Buffer.from('hello')])
})

test('a message dribbling in byte by byte arrives whole', async (t) => {
  const { messages, source } = reading(t)
  const body = Buffer.alloc(300, 0x41)
  const bytes = frame(body)

  const last = bytes.byteLength - 1

  for (let i = 0; i < last; i++) source.push(bytes.subarray(i, i + 1))
  await settle()

  t.absent(messages.length, 'nothing until the last byte')

  source.push(bytes.subarray(last))
  await settle()

  t.alike(messages, [body])
})

test('two messages in one chunk arrive separately', async (t) => {
  const { messages, source } = reading(t)

  source.push(Buffer.concat([frame('one'), frame('two')]))
  await settle()

  t.alike(messages, [Buffer.from('one'), Buffer.from('two')])
})

test('noise before the header is skipped', async (t) => {
  const { messages, source } = reading(t)

  source.push(Buffer.concat([Buffer.from('MESH boot ok\r\n'), frame('hello')]))
  await settle()

  t.alike(messages, [Buffer.from('hello')])
})

test('a chunk with no start byte is dropped', async (t) => {
  const { messages, source } = reading(t)

  source.push(Buffer.from('nothing to see here'))
  await settle()

  t.alike(messages, [], 'noise alone yields nothing')

  source.push(frame('hello'))
  await settle()

  t.alike(messages, [Buffer.from('hello')], 'and does not poison what follows')
})

test('a start byte with the wrong second byte is noise', async (t) => {
  const { messages, source } = reading(t)

  source.push(Buffer.concat([Buffer.from([START1, 0x00, 0x00, 0x01, 0xff]), frame('hello')]))
  await settle()

  t.alike(messages, [Buffer.from('hello')])
})

test('an impossible length resumes the hunt', async (t) => {
  const { messages, source } = reading(t)
  const tooBig = MAX_FRAME + 1
  const header = Buffer.from([START1, START2, tooBig >> 8, tooBig & 0xff])

  source.push(Buffer.concat([header, frame('hello')]))
  await settle()

  t.alike(messages, [Buffer.from('hello')])
})

test('a length over 255 uses both header bytes', async (t) => {
  const { messages, source } = reading(t)
  const long = Buffer.alloc(300, 0x41)

  source.push(frame(long))
  await settle()

  t.alike(messages, [long])
})

test('a slow reader does not lose a message', async (t) => {
  const source = new FakeRadio()
  const framed = new meshtastic.Framed(source)
  t.teardown(() => framed.destroy())

  const count = 64
  const big = Buffer.alloc(MAX_FRAME, 0x41)

  for (let i = 0; i < count; i++) source.push(frame(big))
  await settle()

  const messages = []
  framed.on('data', (message) => messages.push(message))
  for (let i = 0; i < count; i++) await settle()

  t.is(messages.length, count, 'the link was paused, not drained into nowhere')
})

test('a write prepends the length header', async (t) => {
  const source = new FakeRadio()
  const framed = new meshtastic.Framed(source)
  t.teardown(() => framed.destroy())

  framed.write(Buffer.from('hi'))
  await settle()

  t.is(source.written.length, 1, 'one frame is one write')
  t.alike(source.written[0], Buffer.from([START1, START2, 0x00, 0x02, ...Buffer.from('hi')]))
})

test('a write past the maximum fails instead of truncating', (t) => {
  t.plan(1)

  const source = new FakeRadio()
  const framed = new meshtastic.Framed(source)

  framed.on('error', (err) => t.is(err.message, 'message is 513 bytes, max is ' + MAX_FRAME))
  framed.write(Buffer.alloc(MAX_FRAME + 1))
})

test('an error on the link tears the stream down', (t) => {
  t.plan(1)

  const source = new FakeRadio()
  const framed = new meshtastic.Framed(source)

  framed.on('error', (err) => t.is(err.message, 'serial port went away'))
  source.emit('error', new Error('serial port went away'))
})

test('the link running out of bytes ends the stream', (t) => {
  t.plan(1)

  const source = new FakeRadio()
  const framed = new meshtastic.Framed(source)

  framed.on('end', () => t.pass('no more bytes is no more messages'))
  framed.resume()
  source.push(null)
})

test('closing the link closes the stream', (t) => {
  t.plan(1)

  const source = new FakeRadio()
  const framed = new meshtastic.Framed(source)

  framed.on('close', () => t.pass('the stream followed the link'))
  source.destroy()
})

test('a client reads a framed link that fragments', (t) => {
  t.plan(1)

  const source = new FakeRadio()
  const framed = new meshtastic.Framed(source)
  const client = new meshtastic.Client(framed)
  t.teardown(() => client.destroy())

  client.on('node', (node) => t.is(node.num, 0xdeadbeef))

  const bytes = frame(sub(4, [...tag(1, 0), ...varint(0xdeadbeef)]))
  source.push(bytes.subarray(0, 5))
  source.push(bytes.subarray(5))
})

function frame(payload) {
  const body = Buffer.from(payload)

  return Buffer.concat([
    Buffer.from([START1, START2, (body.byteLength >> 8) & 0xff, body.byteLength & 0xff]),
    body
  ])
}

function reading(t) {
  const messages = []
  const source = new FakeRadio()
  const framed = new meshtastic.Framed(source)

  t.teardown(() => framed.destroy())
  framed.on('data', (message) => messages.push(message))

  return { messages, source, framed }
}
