require('dotenv').config()

const Debug = require('debug')
Debug.log = console.log.bind(console)

const debug = require('debug')('sms:main')

const express = require('express')
const bodyParser = require('body-parser')

const { ESME } = require('./lib/esme')
const { handleSendSMS } = require('./lib/apiHandlers')
const config = require('./lib/config')
const { version } = require('./package')

debug('start SMPP gateway v%s', version)

const esme = new ESME(config)

esme.on('connect', async() => {
  debug('SMSC connection ready')
})

const app = express()

app.use(bodyParser.json())

app.use((err, req, res, next) => {
  debug(err.stack)
  res.status(500).send(err.message)
})

app.listen(config.server.port, () => {
  debug('server listening at', config.server.port)
}).on('error', err => {
  debug('app error', err)
})

app.post('/sendSMS', async(req, res) => {
  try {
    await handleSendSMS(res, req, { esme, password: config.server.password })
  } catch (e) {
    debug('handler error', e)
    res.status(500)
    res.end()
  }
})
