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

`Client` adds the conversation - the config sync, the admin passkey, the node database - over any stream of framed messages.

```js
const { Client } = require('bare-meshtastic')

const client = new Client(radio) // a Duplex of whole FromRadio / ToRadio messages

client.on('ready', () => console.log(client.id, client.nodes.size, 'nodes'))
client.on('message', (m) => console.log(m.name, m.text, m.snr))
client.on('ack', (a) => console.log('delivered:', a.delivered))

client.sync()
```

Over BLE that stream's `_read` is one characteristic read, and an empty answer means the radio's queue is drained rather than end of stream. Over serial or TCP it is the link itself. Either way you get backpressure in both directions, and `send` tells you when to wait.

Scan for `meshtastic.SERVICE_UUID`, then open `TO_RADIO_UUID`, `FROM_RADIO_UUID` and `FROM_NUM_UUID`.

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
