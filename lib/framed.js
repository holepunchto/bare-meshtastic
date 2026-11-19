const { Duplex } = require('bare-stream')

const START1 = 0x94
const START2 = 0xc3
const HEADER = 4

// The radio gives up on a length this large and resumes hunting for START1.
const MAX_FRAME = 512

// Meshtastic's framing for links that carry bytes rather than messages: a
// 4-byte header, chosen so it cannot be mistaken for 7-bit ASCII, then the
// protobuf. Over BLE nothing needs this - one characteristic read is already
// one message - but a serial or TCP link has to be reframed before a Client
// can read it.
module.exports = class Framed extends Duplex {
  constructor(stream) {
    super()

    this._stream = stream
    this._buffer = Buffer.alloc(0)

    stream.on('data', (chunk) => this._onchunk(chunk))
    stream.on('end', () => this.push(null))
    stream.on('error', (err) => this.destroy(err))
    stream.on('close', () => this.destroy())
  }

  _read() {
    this._stream.resume()
  }

  _write(message, encoding, cb) {
    if (message.byteLength > MAX_FRAME) {
      return cb(new Error('message is ' + message.byteLength + ' bytes, max is ' + MAX_FRAME))
    }

    const frame = Buffer.allocUnsafe(HEADER + message.byteLength)

    frame[0] = START1
    frame[1] = START2
    frame[2] = (message.byteLength >> 8) & 0xff
    frame[3] = message.byteLength & 0xff
    frame.set(message, HEADER)

    this._stream.write(frame, cb)
  }

  _destroy(err, cb) {
    this._stream.destroy()
    cb(err)
  }

  _onchunk(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk])

    while (true) {
      const start = this._buffer.indexOf(START1)
      if (start === -1) {
        this._buffer = Buffer.alloc(0)
        return
      }

      if (start > 0) this._buffer = this._buffer.subarray(start)
      if (this._buffer.byteLength < HEADER) return

      const length = (this._buffer[2] << 8) | this._buffer[3]

      // Anything but a header here is noise, and so is an impossible length.
      if (this._buffer[1] !== START2 || length > MAX_FRAME) {
        this._buffer = this._buffer.subarray(1)
        continue
      }

      if (this._buffer.byteLength < HEADER + length) return

      const message = this._buffer.subarray(HEADER, HEADER + length)
      this._buffer = this._buffer.subarray(HEADER + length)
      if (this.push(message) === false) this._stream.pause()
    }
  }
}
