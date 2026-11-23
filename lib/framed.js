const { Duplex } = require('bare-stream')

const START1 = 0x94
const START2 = 0xc3
const HEADER = 4
const MAX_FRAME = 512

const AT_START2 = 1
const AT_LENGTH = 2

module.exports = class Framed extends Duplex {
  constructor(stream) {
    super()

    this._stream = stream
    this._chunks = []
    this._buffered = 0
    this._frame = -1

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
    this._chunks.push(chunk)
    this._buffered += chunk.byteLength

    if (this._frame === -1) this._onbeforeframe()
    else this._onafterframe()
  }

  // Hunting for a header, which means looking at bytes.
  _onbeforeframe() {
    while (this._buffered >= HEADER) {
      const buffer = this._collapse()
      const start = buffer.indexOf(START1)

      if (start === -1) {
        this._chunks = []
        this._buffered = 0
        return
      }

      if (start > 0) {
        this._consume(start)
        continue
      }

      const length = buffer.readUInt16BE(AT_LENGTH)

      if (buffer[AT_START2] !== START2 || length > MAX_FRAME) {
        this._consume(1)
        continue
      }

      this._frame = HEADER + length
      if (this._buffered < this._frame) return

      this._onframe()
    }
  }

  // The length is known, so the counter answers on its own: no concat until
  // the whole frame is in, which is what keeps a split body from being copied
  // once per chunk.
  _onafterframe() {
    if (this._buffered < this._frame) return

    this._onframe()
    this._onbeforeframe()
  }

  _onframe() {
    const buffer = this._collapse()
    const message = buffer.subarray(HEADER, this._frame)

    this._consume(this._frame)
    this._frame = -1

    if (this.push(message) === false) this._stream.pause()
  }

  _collapse() {
    const buffer = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks)

    this._chunks = [buffer]

    return buffer
  }

  _consume(length) {
    const buffer = this._chunks[0]

    this._buffered -= length
    this._chunks = this._buffered > 0 ? [buffer.subarray(length)] : []
  }
}
