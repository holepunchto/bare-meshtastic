const { Duplex } = require('bare-stream')
const protocol = require('./protocol')

// Meshtastic over a GATT link is a mailbox, not a push feed: FromNum says
// something arrived, FromRadio hands over one message per read, and an empty
// read means the queue is drained for now. `_read` is exactly that pull, so
// the stream machinery gives us the drain loop and backpressure for free.
module.exports = class Mailbox extends Duplex {
  constructor(peripheral, characteristics, { close = noop } = {}) {
    super()

    for (const name of ['toRadio', 'fromRadio', 'fromNum']) {
      if (!characteristics[name]) throw new Error('characteristics.' + name + ' is missing')
    }

    this._peripheral = peripheral
    this._characteristics = characteristics
    this._close = close
    this._reading = false
    this._wanted = false
    this._again = false
    this._pending = null

    peripheral.on('read', (characteristic, data) => {
      if (is(characteristic, protocol.FROM_RADIO_UUID)) this._onread(data)
    })

    peripheral.on('write', (characteristic) => {
      if (is(characteristic, protocol.TO_RADIO_UUID)) this._onwrite()
    })

    peripheral.on('notify', (characteristic) => {
      if (is(characteristic, protocol.FROM_NUM_UUID)) this._pull()
    })
  }

  _read() {
    this._wanted = true
    this._pull()
  }

  _pull() {
    if (!this._wanted || this.destroyed) return

    if (this._reading) {
      this._again = true
      return
    }

    this._reading = true
    this._again = false
    this._peripheral.read(this._characteristics.fromRadio)
  }

  _onread(data) {
    this._reading = false

    // Android reports a zero-length value as null.
    if (data === null || data.byteLength === 0) {
      if (this._again) this._pull()
      return
    }

    this._wanted = false
    this.push(data)
  }

  _write(message, encoding, cb) {
    this._pending = cb
    this._peripheral.write(this._characteristics.toRadio, message, true)
  }

  _onwrite() {
    const cb = this._pending
    this._pending = null
    if (cb) cb(null)

    // A write is a request and its answer lands in the mailbox, so asking is
    // on us: the radio does not always nudge for its own reply.
    this._pull()
  }

  _destroy(err, cb) {
    this._close(this._peripheral)
    cb(err)
  }
}

function is(characteristic, uuid) {
  return characteristic.uuid.toLowerCase() === uuid
}

function noop() {}
