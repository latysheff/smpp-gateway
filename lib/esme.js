const debug = require('debug')('smpp:esme')
const dump = require('debug')('smpp:esme:dump')

const { EventEmitter } = require('events')
const { RateLimiter } = require('limiter')

const smpp = require('smpp')
const SMPP_ERRORS = {}
for (const error in smpp.errors) {
  SMPP_ERRORS[smpp.errors[error]] = error
}

const { deliveryFlags, encodeUdh } = require('./helpers')

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

    const defaults = {
      connection: {
        host: '127.0.0.1',
        port: '2775'
      },
      bind_transceiver: {
        system_type: 'test',
        interface_version: '0x34',
        addr_ton: '0',
        addr_npi: '0',
        address_range: ''
      },
      submit_sm: {
        source_addr_ton: '1',
        source_addr_npi: '1',
        dest_addr_ton: '1',
        dest_addr_npi: '1'
      },
      timeouts: {
        reconnect: '3000',
        reconnect_long: '5000',
        ping: '3000',
        activity: '60000'
      }
    }

    this.options = Object.assign({}, defaults, options)

    this.timeouts = this.options.timeouts

    this._pingTimeout = null
    this._reconnectCount = 0

    const { connection } = this.options
    this.smppUrl = `smpp://${connection.host}:${connection.port}`

    const { throttle } = this.options
    if (throttle) {
      this.limiter = new RateLimiter(+throttle.count, +throttle.period, true)
    }

    this._state = {
      stopped: false,
      reconnecting: false,
      connecting: false,
      connected: false,
      bound: false,
      pinging: false,
      throttled: false
    }

    process.on('SIGINT', async () => {
      debug('caught SIGINT')
      await Promise.race([this.stop(), new Promise(resolve => setTimeout(resolve, 1000))])
      process.exit()
    })
  }

  connect () {
    if (this._state.connecting) return
    this._state.connecting = true

    debug('connecting to', this.smppUrl)
    this.emit('connecting')

    this.session = smpp.connect(this.smppUrl)

    this.session.on('connect', async () => {
      this._state.connecting = false
      this._state.connected = true
      this._reconnectCount = 0

      debug('connected')
      this.emit('connect')

      await this.bind()

      this.updateActivity()

      // confirm enquire_link
      this.session.on('enquire_link', (pdu) => { this.session.send(pdu.response()) })

      // confirm deliver_sm
      this.session.on('deliver_sm', this.receiveMessage.bind(this))

      // confirm data_sm
      this.session.on('data_sm', this.receiveMessage.bind(this))

      // dump all outgoing messages
      this.session.on('send', (pdu) => {
        dump('>> %j', pdu)
      })

      // dump all incoming messages
      this.session.on('pdu', (pdu) => {
        dump('<< %j', pdu)
      })
    })

    this.session.on('close', () => {
      debug('connection closed')
      this.emit('close')

      if (this._state.stopped) return

      this.reconnect()
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

    this.session.close()

    const timeout = this._reconnectCount === 1 ? this.timeouts.reconnect : this.timeouts.reconnect_long
    debug('reconnect in %d ms...', timeout)
    this.emit('reconnecting', timeout)

    clearTimeout(this._pingTimeout)

    setTimeout(() => {
      this._state.reconnecting = false
      this.connect()
    }, timeout || 60000)
  }

  updateActivity () {
    clearTimeout(this._pingTimeout)

    this._pingTimeout = setTimeout(async () => {
      if (this._state.pinging) return
      this._state.pinging = true

      debug('enquire_link...')

      try {
        await Promise.race([
          new Promise(resolve => this.session.enquire_link({}, () => {
            resolve()
          })),
          new Promise((resolve, reject) => setTimeout(reject, this.timeouts.ping))
        ])

        debug('enquire_link OK')
        this.updateActivity()
      } catch (e) {
        debug('enquire_link timeout')
        this.reconnect()
      }

      this._state.pinging = false
    }, this.timeouts.activity)
  }

  receiveMessage (pdu) {
    this.updateActivity()

    const { command } = pdu
    debug('incoming %s %j', command, pdu)
    this.emit('message', pdu)

    const params = {}
    // confirm receipted_message_id
    if (pdu.receipted_message_id) {
      params.message_id = pdu.receipted_message_id
    }

    this.session.send(pdu.response(params))
  }

  async sendMessage (message) {
    debug('send message %j', message)

    if (!this._state.bound) throw new AppError('can\'t submit in unbound state', 'ERR_ESME_UNBOUND')
    if (this._state.throttled) throw new AppError('server throttle', 'ERR_ESME_THROTTLE_SERVER')
    if (!validate(message)) throw new AppError('invalid request', 'ERR_ESME_VALIDATION')

    if (this.limiter) {
      let remains = this.limiter.getTokensRemaining()
      debug('tokens remaining', remains)
      if (remains <= 0) throw new AppError('client throttle', 'ERR_ESME_THROTTLE_CLIENT')
      remains = await this._consumeLimiter()
      if (remains <= 0) throw new AppError('client throttle triggered', 'ERR_ESME_THROTTLE_CLIENT')
    }

    const encoding = message.encoding ? message.encoding.toLowerCase() : message.encoding
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
        pdu.data_coding = 0x08
      } else if (encoding === 'binary') {
        pdu.data_coding = 0x04
        pdu.short_message.message = Buffer.from(message.content, 'hex')
      }
    }

    if (message.udh) {
      pdu.short_message.udh = encodeUdh(message.udh)
    }

    const messageId = await this.submit(pdu)
    if (messageId) {
      debug('confirmed msg id:', messageId)
    }

    this.updateActivity()
  }

  async _consumeLimiter () {
    return new Promise((resolve, reject) => {
      this.limiter.removeTokens(1, (err, remainingRequests) => {
        if (err) return reject(err)
        resolve(remainingRequests)
      })
    })
  }

  _checkError (status) {
    const code = SMPP_ERRORS[status]
    let message = 'submit error'
    debug('response status code %s (%d)', code, status)

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

  async submit (pdu) {
    if (this._state.throttled) throw new AppError('server throttle', 'ERR_ESME_THROTTLE_SERVER')

    pdu = Object.assign({}, this.options.submit_sm, pdu)
    debug('submitting pdu %O', pdu)
    this.emit('send')

    await new Promise((resolve, reject) => {
      try {
        this.session.submit_sm(pdu, (resp) => {
          const error = this._checkError(resp.command_status)
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

  async bind () {
    debug('bind transceiver')
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

          this.reconnect()

          reject(err)
        }
      })
    })
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
}

module.exports = { ESME }
