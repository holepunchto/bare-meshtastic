const test = require('brittle')
const EventEmitter = require('bare-events')
const meshtastic = require('..')
const { settle, varint, tag, sub, wantConfigId } = require('./helpers')

// Every read is a round trip, so a few ticks have to pass before a mailbox
// has handed over everything it holds.
const TICKS = 10

test('a read hands over one message', async (t) => {
  const radio = new FakePeripheral()
  radio.queue.push(Buffer.from('one'), Buffer.from('two'))

  const { messages } = reading(t, radio)
  await quiet()

  t.alike(messages, [Buffer.from('one'), Buffer.from('two')])
})

test('an empty read means drained, not finished', async (t) => {
  const radio = new FakePeripheral()
  const { messages } = reading(t, radio)
  await quiet()

  t.alike(messages, [], 'an empty mailbox yields nothing')

  radio.queue.push(Buffer.from('later'))
  radio.emit('notify', characteristics.fromNum)
  await quiet()

  t.alike(messages, [Buffer.from('later')], 'and the stream is still open for it')
})

test('a null value is an empty read', async (t) => {
  const radio = new FakePeripheral({ auto: false })
  const { messages } = reading(t, radio)
  await quiet()

  radio.answer(null)
  await quiet()

  t.alike(messages, [], 'android reports zero length as null')
})

test('only one read is ever in flight', async (t) => {
  const radio = new FakePeripheral({ auto: false })
  reading(t, radio)
  await quiet()

  t.is(radio.reads, 1, 'the stream asked once')

  radio.emit('notify', characteristics.fromNum)
  radio.emit('notify', characteristics.fromNum)
  radio.emit('notify', characteristics.fromNum)

  t.is(radio.reads, 1, 'three nudges mid-read add no reads')

  radio.answer(null)
  await quiet()

  t.is(radio.reads, 2, 'they collapse into one')
})

test('a reader that stops stops the reads', async (t) => {
  const radio = new FakePeripheral()
  for (let i = 0; i < 200; i++) radio.queue.push(Buffer.alloc(512, i))

  const messages = []
  const mailbox = new meshtastic.Mailbox(radio, characteristics)
  t.teardown(() => mailbox.destroy())

  mailbox.on('data', (message) => {
    messages.push(message)
    if (messages.length === 5) mailbox.pause()
  })

  for (let i = 0; i < 100; i++) await settle()

  t.ok(radio.reads < 50, 'read ' + radio.reads + ' of 200 and then waited')

  mailbox.resume()
  for (let i = 0; i < 500; i++) await settle()

  t.is(messages.length, 200, 'the rest came once the reader came back')
})

test('a write goes to ToRadio and finishes on the response', (t) => {
  t.plan(2)

  const radio = new FakePeripheral()
  const mailbox = new meshtastic.Mailbox(radio, characteristics)
  t.teardown(() => mailbox.destroy())

  mailbox.write(Buffer.from('hi'), () => {
    t.alike(radio.written, [Buffer.from('hi')])
    t.alike(radio.wrote, [characteristics.toRadio])
  })
})

test('uppercase characteristic uuids still match', async (t) => {
  const shouting = {
    toRadio: { uuid: meshtastic.TO_RADIO_UUID.toUpperCase() },
    fromRadio: { uuid: meshtastic.FROM_RADIO_UUID.toUpperCase() },
    fromNum: { uuid: meshtastic.FROM_NUM_UUID.toUpperCase() }
  }

  const radio = new FakePeripheral()
  radio.queue.push(Buffer.from('one'))

  const messages = []
  const mailbox = new meshtastic.Mailbox(radio, shouting)
  t.teardown(() => mailbox.destroy())
  mailbox.on('data', (message) => messages.push(message))
  await quiet()

  t.alike(messages, [Buffer.from('one')], 'ios shouts its uuids')
})

test('another characteristic is not the mailbox', async (t) => {
  const radio = new FakePeripheral({ auto: false })
  const { messages } = reading(t, radio)
  await quiet()

  radio.emit('read', { uuid: meshtastic.SERVICE_UUID }, Buffer.from('not mine'))
  await quiet()

  t.alike(messages, [], 'a read of something else is not a message')

  radio.answer(Buffer.from('mine'))
  await quiet()

  t.alike(messages, [Buffer.from('mine')])
})

test('a response from another characteristic does not finish a write', async (t) => {
  const radio = new FakePeripheral({ auto: false })
  const mailbox = new meshtastic.Mailbox(radio, characteristics)
  t.teardown(() => mailbox.destroy())

  let done = false
  mailbox.write(Buffer.from('hi'), () => (done = true))
  await quiet()

  radio.emit('write', { uuid: meshtastic.SERVICE_UUID })
  await quiet()

  t.absent(done, 'a response elsewhere is not our response')

  radio.respond()
  await quiet()

  t.ok(done, 'ours is')
})

test('a missing characteristic is refused up front', (t) => {
  const radio = new FakePeripheral()
  const { toRadio, fromRadio, fromNum } = characteristics

  t.exception(() => new meshtastic.Mailbox(radio, { fromRadio, fromNum }), /toRadio is missing/)
  t.exception(() => new meshtastic.Mailbox(radio, { toRadio, fromNum }), /fromRadio is missing/)
  t.exception(() => new meshtastic.Mailbox(radio, { toRadio, fromRadio }), /fromNum is missing/)
})

test('destroy hands the link back', async (t) => {
  const radio = new FakePeripheral()
  const closed = []
  const mailbox = new meshtastic.Mailbox(radio, characteristics, {
    close: (peripheral) => closed.push(peripheral)
  })

  mailbox.destroy()
  await quiet()

  t.alike(closed, [radio], 'whoever opened the link is the one who closes it')
})

test('a nudge after destroy reads nothing', async (t) => {
  const radio = new FakePeripheral({ auto: false })
  const { mailbox } = reading(t, radio)
  await quiet()

  mailbox.destroy()
  await quiet()

  const before = radio.reads
  radio.emit('notify', characteristics.fromNum)

  t.is(radio.reads, before, 'a late notify finds the stream gone')
})

test('a client syncs over a mailbox', (t) => {
  t.plan(2)

  const radio = new FakePeripheral()
  const mailbox = new meshtastic.Mailbox(radio, characteristics)
  const client = new meshtastic.Client(mailbox)
  t.teardown(() => client.destroy())

  client.on('ready', () => {
    t.is(client.id, '!deadbeef')
    t.is(client.nodes.size, 1)
  })

  radio.on('write', () => {
    const id = wantConfigId(radio.written[0])

    radio.queue.push(
      Buffer.from(sub(3, [...tag(1, 0), ...varint(0xdeadbeef)])),
      Buffer.from(sub(4, [...tag(1, 0), ...varint(0xc0ffee)])),
      Buffer.from([...tag(7, 0), ...varint(id)])
    )

    radio.emit('notify', characteristics.fromNum)
  })

  client.sync()
})

test('a radio that answers without a nudge still gets drained', async (t) => {
  const radio = new FakePeripheral()
  const mailbox = new meshtastic.Mailbox(radio, characteristics)
  const client = new meshtastic.Client(mailbox)
  t.teardown(() => client.destroy())

  // A real radio queues its answer and nudges nobody: the write is the nudge.
  radio.answers = (frame) => {
    const id = wantConfigId(frame)

    radio.queue.push(
      Buffer.from(sub(3, [...tag(1, 0), ...varint(0xdeadbeef)])),
      Buffer.from([...tag(7, 0), ...varint(id)])
    )
  }

  let ready = false
  client.on('ready', () => (ready = true))

  client.sync()
  await quiet()

  t.ok(ready, 'the node database arrived')
})

const characteristics = {
  toRadio: { uuid: meshtastic.TO_RADIO_UUID },
  fromRadio: { uuid: meshtastic.FROM_RADIO_UUID },
  fromNum: { uuid: meshtastic.FROM_NUM_UUID }
}

// A radio as its GATT link sees it: reads answer one queued message, writes
// answer with a response on the same characteristic.
class FakePeripheral extends EventEmitter {
  constructor({ auto = true } = {}) {
    super()

    this.auto = auto
    this.queue = []
    this.reads = 0
    this.written = []
    this.wrote = []
    this._reading = null
    this._writing = null
  }

  read(characteristic) {
    this.reads++
    this._reading = characteristic

    if (this.auto) this.answer(this.queue.shift())
  }

  answer(data) {
    if (this._reading === null) throw new Error('nothing asked for a message')

    const characteristic = this._reading
    this._reading = null

    setImmediate(() => this.emit('read', characteristic, data === undefined ? null : data))
  }

  write(characteristic, data) {
    this.written.push(data)
    this.wrote.push(characteristic)
    this._writing = characteristic

    // A radio queues its reply before it acknowledges the write.
    if (this.answers) this.answers(data)
    if (this.auto) this.respond()
  }

  respond() {
    if (this._writing === null) throw new Error('nothing was written')

    const characteristic = this._writing
    this._writing = null

    setImmediate(() => this.emit('write', characteristic))
  }
}

async function quiet() {
  for (let i = 0; i < TICKS; i++) await settle()
}

function reading(t, radio) {
  const messages = []
  const mailbox = new meshtastic.Mailbox(radio, characteristics)

  t.teardown(() => mailbox.destroy())
  mailbox.on('data', (message) => messages.push(message))

  return { messages, mailbox }
}
