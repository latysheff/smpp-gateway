const debug = require('debug')('smpp:esme')
const dump = require('debug')('smpp:esme:dump')

const { EventEmitter } = require('events')
const { RateLimiter } = require('limiter')
const { UDH } = require('sms-3gpp')

const smpp = require('smpp')
const SMPP_ERRORS = {}
for (const error in smpp.errors) {
  SMPP_ERRORS[smpp.errors[error]] = error
}

const Ajv = require('ajv')
const ajv = new Ajv()
const schema = require('./schema.json')
const validate = ajv.compile(schema)

class AppError extends Error {
  constructor (message, code) {
    super()

    this.code = code || 'ERR_ESME'
    this.message = message

    Error.captureStackTrace(this, this.constructor)
  }
}

class ESME extends EventEmitter {
  constructor (options) {
    super()

    this.options = options

    this.timeouts = options.timeouts || {}
    this.timeouts.reconnect = this.timeouts.reconnect || 3000
    this.timeouts.reconnect_long = this.timeouts.reconnect_long || 5000
    this.timeouts.ping = this.timeouts.ping || 8000
    this.timeouts.activity = this.timeouts.activity || 60000

    this.system_id = options.bind_transceiver.system_id
    this._activityTimeout = null
    this._reconnectCount = 0

    const { throttle } = options
    if (throttle) {
      this.limiter = new RateLimiter(+throttle.count, +throttle.period, true)
    }

    this.url = `smpp://${options.connection.host}:${options.connection.port}`

    this._state = {
      stopped: false,
      reconnecting: false,
      connecting: false,
      connected: false,
      bound: false,
      pinging: false,
      throttled: false
    }

    process.on('SIGINT', async() => {
      debug('caught SIGINT')
      await Promise.race([this.stop(), new Promise(resolve => setTimeout(resolve, 1000))])
      process.exit()
    })
  }

  async removeTokens (count = 1) {
    return new Promise((resolve, reject) => {
      this.limiter.removeTokens(count, (err, remainingRequests) => {
        if (err) return reject(err)
        resolve(remainingRequests)
      })
    })
  }

  connect () {
    if (this._state.connecting) return
    this._state.connecting = true

    debug('connecting to', this.url)
    this.emit('connecting')

    this.session = smpp.connect(this.url)

    this.session.on('connect', async() => {
      this._state.connecting = false
      this._state.connected = true
      this._reconnectCount = 0

      debug('connected')
      this.emit('connect')

      await this.bind_transceiver()
      this._sessionListeners()
      this._scheduleNextPing()
    })

    this.session.on('close', () => {
      debug('connection closed')
      this.emit('close')

      if (!this._state.stopped) {
        this.reconnect()
      }
    })

    this.session.on('error', (err) => {
      this.emit('error', err)
    })
  }

  reconnect () {
    if (this._state.reconnecting) return
    this._state.reconnecting = true

    this._state.connecting = false
    this._state.connected = false
    this._state.bound = false
    this._state.throttled = false

    this._reconnectCount++

    const timeout = this._reconnectCount === 1 ? this.timeouts.reconnect : this.timeouts.reconnect_long
    debug('reconnect in %d ms...', timeout)
    this.emit('reconnecting', timeout)

    clearTimeout(this._activityTimeout)

    setTimeout(() => {
      this._state.reconnecting = false
      this.connect()
    }, timeout || 60000)
  }

  async bind_transceiver () {
    debug('bind transceiver as "%s"', this.system_id)
    this.emit('binding')

    await new Promise((resolve, reject) => {
      this.session.bind_transceiver(this.options.bind_transceiver, (pdu) => {
        if (pdu.command_status === 0) {
          if (pdu.system_id) this.sc_system_id = pdu.system_id
          if (pdu.sc_interface_version) this.sc_interface_version = pdu.sc_interface_version.toString(16)

          this._state.bound = true
          debug('bound to service centre: id %s, protocol version %s', this.sc_system_id, this.sc_interface_version)
          this.emit('bound')
          this.emit('ready')

          resolve()
        } else {
          const code = SMPP_ERRORS[pdu.command_status]
          const err = new AppError('bind failed', code)
          this.emit('error', err)

          this.session.close()
          this.reconnect()

          reject(err)
        }
      })
    })
  }

  _sessionListeners () {
    // confirm enquire_link
    this.session.on('enquire_link', (pdu) => { this.session.send(pdu.response()) })

    // confirm deliver_sm
    this.session.on('deliver_sm', this.accept.bind(this))

    // confirm data_sm
    this.session.on('data_sm', this.accept.bind(this))

    // dump all outgoing messages
    this.session.on('send', (pdu) => {
      dump('>> %j', pdu)
    })

    // dump all incoming messages
    this.session.on('pdu', (pdu) => {
      dump('<< %j', pdu)
    })
  }

  ping () {
    if (this._state.pinging) return
    this._state.pinging = true

    debug('enquire_link...')

    const reconnectOnPingTimeout = setTimeout(() => {
      debug('enquire_link timeout %d ms', this.timeouts.ping)
      this._state.pinging = false
      this.reconnect()
    }, this.timeouts.ping)

    this.session.enquire_link({}, () => {
      debug('enquire_link OK')
      this._state.pinging = false
      clearTimeout(reconnectOnPingTimeout)
      this._scheduleNextPing()
    })
  }

  _scheduleNextPing () {
    clearTimeout(this._activityTimeout)
    this._activityTimeout = setTimeout(this.ping.bind(this), this.timeouts.activity)
  }

  accept (pdu) {
    this._scheduleNextPing()
    debug('do accept', pdu)

    const resp = {}
    if (pdu.receipted_message_id) {
      debug('confirm receipted_message_id', pdu.receipted_message_id)
      resp.message_id = pdu.receipted_message_id
    }

    this.session.send(pdu.response(resp))

    // todo API callback (if enabled in settings)
  }

  async sendMessage (message) {
    debug('request to send message %j', message)

    if (!this._state.bound) throw new AppError('can\'t submit in unbound state', 'ERR_ESME_UNBOUND')
    if (this._state.throttled) throw new AppError('server throttle', 'ERR_ESME_THROTTLE_SERVER')
    if (!validate(message)) throw new AppError('invalid request', 'ERR_ESME_VALIDATION')

    if (this.limiter) {
      let remains = this.limiter.getTokensRemaining()
      debug('tokens remaining', remains)
      if (remains <= 0) throw new AppError('client throttle', 'ERR_ESME_THROTTLE_CLIENT')
      remains = await this.removeTokens()
      if (remains <= 0) throw new AppError('client throttle triggered', 'ERR_ESME_THROTTLE_CLIENT')
    }

    const encoding = message.encoding ? message.encoding.toLowerCase() : ''
    const content = message.content
    debug('content encoding %s, length %d', encoding, content.length)

    // assert(encoding === 'ucs2' && content.length <= 67 || encoding !== 'ucs2' && content.length <= 160, 'too long')
    // assert(encoding === 'binary' || (encoding === 'ucs2' && content.length <= 67) || (encoding !== 'ucs2' && content.length <= 160), 'too long')

    const pdu = {}

    if ('pid' in message) pdu.protocol_id = message.pid

    if ('dcs' in message) pdu.data_coding = message.dcs

    pdu.destination_addr = message.destination
    pdu.registered_delivery = deliveryFlags(message.report)

    pdu.short_message = {
      message: content
    }

    if (encoding) {
      if (encoding === 'ucs2') {
        pdu.short_message.encoding = 'UCS2'
      } else if (encoding === 'binary') {
        pdu.short_message.message = Buffer.from(message.content, 'hex')
      }
    }

    if (message.udh) {
      pdu.short_message.udh = UDH.encode(message.udh)
    }

    const messageId = await this.submit_sm(pdu)
    if (messageId) {
      debug('confirmed msg id:', messageId)
    }

    this._scheduleNextPing()
  }

  checkResponseStatus (pdu) {
    const code = SMPP_ERRORS[pdu.command_status]
    let message = 'submit error'
    debug('response status code %s (%d)', code, pdu.command_status)

    switch (code) {
      case 'ESME_ROK':
        return
      case 'ESME_RTHROTTLED':
        message = 'server throttle triggered'
        this._state.throttled = true
        setTimeout(() => {
          this._state.throttled = false
        }, 60000)
        break
      case 'ESME_RMSGQFUL':
        message = 'message queue full'
        // Used to indicate a resource error within the MC.
        // This may be interpreted as the maximum number of messages addressed to a single destination
        // or a global maximum of undelivered messages within the MC.
        break
      case 'ESME_RINVDSTADR':
      case 'ESME_RINVDSTTON':
      case 'ESME_RINVDSTNPI':
      case 'ESME_RINVDSTADDRSUBUNIT':
        message = 'invalid address'
        break
    }

    return new AppError(message, code)
  }

  async submit_sm (pdu) {
    if (this._state.throttled) throw new AppError('server throttle', 'ERR_ESME_THROTTLE_SERVER')

    pdu = Object.assign({}, this.options.submit, pdu)
    debug('submitting pdu %O', pdu)

    await new Promise((resolve, reject) => {
      try {
        this.session.submit_sm(pdu, (resp) => {
          const error = this.checkResponseStatus(resp)
          if (error) {
            reject(error)
          } else {
            resolve(resp.message_id)
          }
        })
      } catch (e) {
        debug(e)
        reject(Error('submit error'))
      }
    })
  }

  async stop () {
    debug('stopping')
    this._state.stopped = true

    if (this._state.bound) {
      try {
        await this.unbind()
      } catch (e) {

      }
    }

    if (this._state.connected) {
      await this.disconnect()
    }

    debug('stopped')
  }

  async unbind () {
    debug('unbinding')
    await new Promise((resolve) => {
      this.session.unbind(() => {
        debug('unbound')
        resolve()
      })
    })
  }

  async disconnect () {
    debug('disconnecting')
    await new Promise((resolve) => {
      this.session.close(() => {
        debug('disconnected')
        resolve()
      })
    })
  }
}

function deliveryFlags (report) {
  if (!report) return 0

  /*
  The registered_delivery field (ref. 4.7.21) allows an ESME request a delivery receipt for the message.
  Under normal circumstances, a receipt is typically sent to the ESME when the message reached a final delivery state,
  regardless of whether the message was actually delivered or not.
  However the registered_delivery field provides a number of settings that dictate the requirements for generating the receipt.
  One such example is the value of 2, which requests a receipt only if the message is not delivered when it reaches its final state.
  The following diagram illustrates the use of registered delivery as a means of obtaining a delivery confirmation

  REGISTERED_DELIVERY
  FINAL:                    0x01,
  FAILURE:                  0x02,
  SUCCESS:                  0x03, // v.5.0
  DELIVERY_ACKNOWLEDGEMENT: 0x04,
  USER_ACKNOWLEDGEMENT:     0x08,
  INTERMEDIATE:             0x10
   */

  let receipt = 0
  switch (report.receipt) {
    case 'final':
      receipt = smpp.REGISTERED_DELIVERY.FINAL
      break
    case 'failure':
      receipt = smpp.REGISTERED_DELIVERY.FAILURE
      break
    case 'success':
      receipt = smpp.REGISTERED_DELIVERY.SUCCESS
      break
  }

  const flags = receipt |
    (report.ack && smpp.REGISTERED_DELIVERY.DELIVERY_ACKNOWLEDGEMENT) |
    (report.user_ack && smpp.REGISTERED_DELIVERY.USER_ACKNOWLEDGEMENT) |
    (report.intermediate && smpp.REGISTERED_DELIVERY.INTERMEDIATE)

  return flags
}

module.exports = { ESME }
