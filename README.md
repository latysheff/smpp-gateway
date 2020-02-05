# smpp-gateway

Module provides SMPP External Short Messaging Entity (ESME) behaviour 'out of the box'.
 
It also contains Express routers for HTTP to SMPP gateway and Prometheus metrics.

## Usage example

```
const express = require('express')
const app = express()

const { ESME, gateway, metrics } = require('smpp-gateway')
const config = {} // see examples/client.js

const esme = new ESME(config)

esme.on('ready', async() => {
  await esme.sendMessage({
    destination: '111',
    content: 'hello',
    udh: {
      port: {
        src: 37273,
        dst: 37273
      }
    }
  })
})

app.use('/send', gateway(esme))
app.use('/metrics', metrics(esme))

esme.connect()

app.listen(3000)

```

## Example JSON body for HTTP request

```
{
  "destination": "111",
  "content": "hello",
  "udh": {
    "port": {
      "src": 37273,
      "dst": 37273
    }
  }
}
```

See also `lib/schema.json`

## Mock server
`examples/mock-server.js`

Environment variables for mock server:
```
  SMPP_SMPP_SERVER_ADDRESS,
  SMPP_SMPP_SERVER_PORT,
  SMPP_SYSTEM_ID,
  SMPP_PASSWORD,
  SMPP_THROTTLE_COUNT,
  SMPP_THROTTLE_PERIOD
```
