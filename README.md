> [!IMPORTANT]
> This module is experimental. The API is subject to change and may break at any time.

# bare-meshtastic

Meshtastic protocol codec and client.

Meshtastic defines its own framing and its own exchanges, and both are the same whether the link is BLE, serial or TCP, only the bytes arrive differently. The module holds the state machine and you hold the wire.

```
npm i bare-meshtastic
```

## Usage

The codec on its own is pure functions: messages in, bytes out; bytes in, plain objects out.

```js
const meshtastic = require('bare-meshtastic')

peripheral.write(toRadio, meshtastic.textMessage('hello'), true)

peripheral.on('read', (c, data) => {
  console.log(meshtastic.decode(data))
})
```

`Client` adds the conversation - draining the radio's queue, the config sync, the admin passkey - and asks you only for a way to read and write.

```js
const { Client } = require('bare-meshtastic')

const client = new Client({
  read: () => peripheral.read(fromRadio),
  write: (frame) => peripheral.write(toRadio, frame, true)
})

peripheral.on('notify', () => client.notify())
peripheral.on('read', (c, data) => client.push(data))

client.on('ready', () => console.log(client.id, client.nodes.size, 'nodes'))
client.on('message', (m) => console.log(m.name, m.text, m.snr))

client.sync()
```

Scan for `meshtastic.SERVICE_UUID`, then open `TO_RADIO_UUID`, `FROM_RADIO_UUID` and `FROM_NUM_UUID`.

Over BLE one read returns exactly one message, which is what `push` expects, and an empty read means the queue is drained.

## What it speaks

|               |                                                                       |
| ------------- | --------------------------------------------------------------------- |
| Text messages | send, receive, and the ack that says whether one arrived              |
| Position      | latitude, longitude, altitude                                         |
| Telemetry     | battery, voltage, channel use, uptime                                 |
| Nodes         | the database on connect, and nodes announcing themselves over the air |
| Radio config  | region, modem preset, hop limit                                       |
| Channel slots | read and write, over the admin API                                    |

Anything else a radio sends - waypoints, remote hardware, audio - is skipped by wire type rather than guessed at, so a radio on newer firmware still parses.

## API

See [`index.d.ts`](index.d.ts) for the full typed surface.

The UUIDs come from the [client API docs](https://meshtastic.org/docs/development/device/client-api/).

## License

Apache-2.0
