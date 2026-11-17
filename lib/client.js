const EventEmitter = require('bare-events')
const protocol = require('./protocol')

const SYNC_TIMEOUT = 15000

function noop() {}

module.exports = class Client extends EventEmitter {
  constructor({ read, write, close = noop, log = noop, syncTimeout = SYNC_TIMEOUT }) {
    super()

    this._read = read
    this._write = write
    this._close = close
    this._log = log
    this._syncTimeout = syncTimeout
    this._reading = false
    this._queued = false
    this._configId = -1
    this._syncTimer = null
    this._destroyed = false

    this.nodeNum = 0
    this.nodes = new Map()
    this.config = null
    this.channels = new Map()
  }

  get id() {
    return protocol.nodeId(this.nodeNum)
  }

  sync() {
    if (this._syncTimer) clearTimeout(this._syncTimer)

    this._configId = protocol.randomId()
    this._write(protocol.wantConfig(this._configId))
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null
      this.emit('error', new Error('radio did not finish sending its node database'))
    }, this._syncTimeout)
    this.notify()
  }

  send(text, opts) {
    this.sendPacket(protocol.PORT_TEXT_MESSAGE, Buffer.from(text), opts)
  }

  sendPacket(portnum, payload, opts = {}) {
    this._write(protocol.packet(portnum, payload, { ...opts, wantAck: opts.wantAck ?? true }))
  }

  getChannel(index) {
    this._write(protocol.getChannel(index, this.nodeNum))
  }

  setChannel(index, settings, passkey) {
    this._write(protocol.setChannel(index, settings, passkey, this.nodeNum))
  }

  notify() {
    if (this._destroyed) return

    if (this._reading) {
      this._queued = true
      return
    }

    this._reading = true
    this._read()
  }

  push(data) {
    if (this._destroyed) return

    if (data === null || data.byteLength === 0) {
      this._reading = false

      if (this._queued) {
        this._queued = false
        this.notify()
      }

      return
    }

    try {
      this._handle(protocol.decode(data))
    } catch (err) {
      this.emit('error', err)
    }

    this._read()
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
    this._close()
  }

  [Symbol.dispose]() {
    this.destroy()
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
    const node = { num: packet.from, user, snr: packet.snr, hopsAway: null }

    this.nodes.set(packet.from, node)
    this.emit('node', node)
  }
}
