const EventEmitter = require('bare-events')
const protocol = require('./protocol')

const SYNC_TIMEOUT = 15000

module.exports = class Client extends EventEmitter {
  constructor(stream, { log = noop, syncTimeout = SYNC_TIMEOUT } = {}) {
    super()

    this._stream = stream
    this._log = log
    this._syncTimeout = syncTimeout
    this._configId = -1
    this._syncTimer = null
    this._destroyed = false

    this.nodeNum = 0
    this.nodes = new Map()
    this.config = null
    this.channels = new Map()

    stream.on('data', (data) => this._ondata(data))
    stream.on('error', (err) => this.emit('error', err))
    stream.on('close', () => this.emit('close'))
  }

  get id() {
    return protocol.nodeId(this.nodeNum)
  }

  sync() {
    if (this._syncTimer) clearTimeout(this._syncTimer)

    this._configId = protocol.randomId()
    this._stream.write(protocol.wantConfig(this._configId))
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null
      this.emit('error', new Error('radio did not finish sending its node database'))
    }, this._syncTimeout)
  }

  send(text, opts) {
    return this.sendPacket(protocol.PORT_TEXT_MESSAGE, Buffer.from(text), opts)
  }

  sendPacket(portnum, payload, opts = {}) {
    return this._stream.write(
      protocol.packet(portnum, payload, { ...opts, wantAck: opts.wantAck ?? true })
    )
  }

  getChannel(index) {
    return this._stream.write(protocol.getChannel(index, this.nodeNum))
  }

  setChannel(index, settings, passkey) {
    return this._stream.write(protocol.setChannel(index, settings, passkey, this.nodeNum))
  }

  nameOf(num) {
    const node = this.nodes.get(num)
    if (node && node.user && node.user.shortName) return node.user.shortName

    return protocol.nodeId(num)
  }

  destroy() {
    if (this._destroyed) return

    this._destroyed = true
    if (this._syncTimer) clearTimeout(this._syncTimer)
    this._syncTimer = null
    this._stream.destroy()
  }

  [Symbol.dispose]() {
    this.destroy()
  }

  _ondata(data) {
    let frame

    try {
      frame = protocol.decode(data)
    } catch (err) {
      return this.emit('error', undecodable(err))
    }

    try {
      this._handle(frame)
    } catch (err) {
      this.emit('error', err)
    }
  }

  _handle(frame) {
    this._log('frame', frame.type || 'unknown')

    switch (frame.type) {
      case 'myInfo':
        this.nodeNum = frame.nodeNum
        return

      case 'config':
        this.config = frame.lora
        return

      case 'channel':
        this.channels.set(frame.channel.index, frame.channel)
        return

      case 'nodeInfo':
        this.nodes.set(frame.node.num, frame.node)
        this.emit('node', frame.node)
        return

      case 'configComplete':
        return this._onsynced(frame.configId)

      case 'packet':
        return this._onpacket(frame.packet)
    }
  }

  _onsynced(configId) {
    if (configId !== this._configId) return

    this._configId = -1
    if (this._syncTimer) clearTimeout(this._syncTimer)
    this._syncTimer = null
    this.emit('ready')
  }

  _onpacket(packet) {
    const data = packet.data
    if (!data) return

    switch (data.portnum) {
      case protocol.PORT_ADMIN:
        return this.emit('admin', protocol.decodeAdmin(data.payload))

      case protocol.PORT_ROUTING:
        return this.emit('ack', { id: data.requestId, ...protocol.decodeRouting(data.payload) })
    }

    // The radio echoes our own packet back to every attached client.
    if (packet.from === this.nodeNum) return

    const from = { from: protocol.nodeId(packet.from), name: this.nameOf(packet.from) }

    switch (data.portnum) {
      case protocol.PORT_POSITION:
        return this.emit('position', { ...from, ...protocol.decodePosition(data.payload) })

      case protocol.PORT_TELEMETRY:
        return this.emit('telemetry', { ...from, ...protocol.decodeTelemetry(data.payload) })

      case protocol.PORT_NODEINFO:
        return this._onnode(packet, protocol.decodeUserPayload(data.payload))

      case protocol.PORT_TEXT_MESSAGE:
        return this.emit('message', {
          ...from,
          text: data.payload ? Buffer.from(data.payload).toString() : '',
          snr: packet.snr,
          rssi: packet.rssi,
          hops: packet.hopStart ? packet.hopStart - packet.hopLimit : 0,
          direct: packet.to !== protocol.BROADCAST
        })
    }
  }

  _onnode(packet, user) {
    const node = { ...this.nodes.get(packet.from), num: packet.from, user, snr: packet.snr }

    this.nodes.set(packet.from, node)
    this.emit('node', node)
  }
}

function noop() {}

function undecodable(cause) {
  const err = new Error(
    'could not decode a message from the radio: ' +
      cause.message +
      ' - a Client reads whole messages, so a link that carries bytes has to be wrapped in Framed',
    { cause }
  )

  err.code = 'MESSAGE_UNDECODABLE'

  return err
}
