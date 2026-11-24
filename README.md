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

`Client` adds the conversation - the config sync, the admin passkey, the node database - over a link wrapped in the adapter it needs. Serial and TCP need `Framed`:

```js
const { Client, Framed } = require('bare-meshtastic')

const client = new Client(new Framed(socket))

client.on('ready', () => console.log(client.id, client.nodes.size, 'nodes'))
client.on('message', (m) => console.log(m.name, m.text, m.snr))
client.on('ack', (a) => console.log('delivered:', a.delivered))

client.sync()
```

BLE needs `Mailbox`:

```js
const { Central } = require('bare-bluetooth')
const meshtastic = require('bare-meshtastic')
const { Client, Mailbox } = meshtastic

const central = new Central()

central.on('stateChange', (state) => {
  if (state === 'poweredOn') central.startScan([meshtastic.SERVICE_UUID])
})

central.on('discover', (peripheral) => {
  central.stopScan()
  central.connect(peripheral)
})

central.on('connect', (peripheral) => {
  peripheral.on('servicesDiscover', (services) => {
    peripheral.discoverCharacteristics(services[0])
  })

  peripheral.on('characteristicsDiscover', (service, characteristics) => {
    const find = (uuid) => characteristics.find((c) => c.uuid.toLowerCase() === uuid)
    const fromNum = find(meshtastic.FROM_NUM_UUID)

    const mailbox = new Mailbox(
      peripheral,
      {
        toRadio: find(meshtastic.TO_RADIO_UUID),
        fromRadio: find(meshtastic.FROM_RADIO_UUID),
        fromNum
      },
      { close: () => central.disconnect(peripheral) }
    )

    const client = new Client(mailbox)

    client.on('ready', () => client.send('hello'))
    client.on('message', (m) => console.log(m.name, m.text))

    peripheral.subscribe(fromNum)
    client.sync()
  })

  peripheral.discoverServices([meshtastic.SERVICE_UUID])
})
```

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
