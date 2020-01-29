const express = require('express')
const app = express()

const { ESME, gateway, metrics } = require('../')

const config = {
  connection: {
    host: '127.0.0.1',
    port: '2775'
  },
  bind_transceiver: {
    system_id: 'login',
    password: 'password',
    system_type: 'test',
    interface_version: '0x34',
    addr_ton: '0',
    addr_npi: '0',
    address_range: ''
  },
  submit_sm: {
    source_addr: '1234567',
    source_addr_ton: '1',
    source_addr_npi: '1',
    dest_addr_ton: '1',
    dest_addr_npi: '1'
  },
  timeouts: {
    reconnect: '3000',
    reconnect_long: '5000',
    ping: '8000',
    activity: '60000'
  },
  throttle: {
    count: '20',
    period: '60000'
  }
}

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
