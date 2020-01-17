const debug = require('debug')('sms:esme')
const dump = require('debug')('sms:esme:dump')

const assert = require('assert')
const { EventEmitter } = require('events')

const smpp = require('smpp')
const { RateLimiter } = require('limiter')

const { UDH } = require('sms-3gpp')
assert(UDH, 'need UDH encoding module')
assert(typeof UDH.encode === 'function', 'need UDH encoding function')

class ESME extends EventEmitter {
  constructor (config) {
    super()

    this.pingTimeout = config.pingTimeout
    this.errorCount = 0

    this.isThrottled = false

    this.limiter = new RateLimiter(config.throttle.count, config.throttle.period, true)

    this.config = config
    this.serverUrl = `smpp://${config.connect.host}:${config.connect.port}`

    this.connected = false
    this.bound = false

    process.on('SIGINT', async() => {
      debug('stopping')
      setTimeout(bailout, 1500)
      await this.stop()
      bailout()
    })

    function bailout () {
      // todo
      // http://pm2.keymetrics.io/docs/usage/signals-clean-restart/
      debug('stopped')
      setTimeout(() => {
        process.exit()
      }, 1500)
    }

    setImmediate(this.connect.bind(this))
  }

  connect () {
    if (this.connecting) {
      debug('already connecting')
      return
    }

    this.connecting = true
    debug(`connecting ${this.serverUrl}...`)
    this.session = smpp.connect(this.serverUrl)
    this.session.on('connect', () => {
      debug('connected')

      this.connecting = false
      this.connected = true

      setTimeout(() => {
        this.bindTransmitter()
        this.enableEventProcessing()
      }, 500)
    })

    this.session.on('close', () => {
      debug('socket close')
      this.reconnect()
    })

    this.session.on('error', (err) => {
      debug(err.message)
      this.reconnect()
    })
  }

  reconnect () {
    if (this.reconnecting) {
      // debug('already reconnecting')
      return
    }

    clearTimeout(this.activityTimeout)
    this.reconnecting = true
    this.connecting = false
    this.connected = false
    this.bound = false

    this.errorCount++

    const timeout = this.errorCount === 1 ? this.config.connect.reconnectTimeout : this.config.connect.reconnectTimeoutLonger
    debug('reconnect in %d ms...', timeout)
    setTimeout(() => {
      this.reconnecting = false
      this.connect()
    }, timeout || 60000)
  }

  bindTransmitter () {
    debug('bind transmitter as "%s"...', this.config.bind.system_id)

    this.session.bind_transceiver(this.config.bind, (pdu) => {
      if (pdu.command_status === 0) {
        this.scId = pdu.system_id || undefined
        if (pdu.sc_interface_version) this.scVersion = pdu.sc_interface_version.toString(16)
        debug('bind success to (service centre id: %s, protocol version: %s)', this.scId || 'unknown', this.scVersion || 'default')
        this.errorCount = 0

        this.bound = true

        this.appointNextPing()
        this.emit('connect')
      } else {
        // ESME_RBINDFAIL
        debug('bind error', pdu.command_status, smpp.errors[pdu.command_status])
        this.session.close()
        this.reconnect()
      }
    })
  }

  enableEventProcessing () {
    // обязательно отвечаем ОК на enquire_link
    this.session.on('enquire_link', (pdu) => { this.session.send(pdu.response()) })

    // обязательно отвечаем тупо ОК на deliver_sm
    this.session.on('deliver_sm', this.accept.bind(this))

    // обязательно отвечаем тупо ОК на data_sm
    this.session.on('data_sm', this.accept.bind(this))

    // логируем все!
    this.session.on('send', (pdu) => {
      dump('>> %j', pdu)
    })

    this.session.on('pdu', (pdu) => {
      dump('<< %j', pdu)
    })
  }

  ping () {
    if (this.pinging) {
      debug('already pinging')
      return
    }

    debug('enquire_link...')
    this.pinging = true

    const reconnectOnPingTimeout = setTimeout(() => {
      debug('enquire_link timeout %d ms', this.pingTimeout)
      this.pinging = false
      this.reconnect()
    }, this.pingTimeout)

    this.session.enquire_link({}, () => {
      debug('enquire_link OK')
      this.pinging = false
      clearTimeout(reconnectOnPingTimeout)
      this.appointNextPing()
    })
  }

  appointNextPing () {
    clearTimeout(this.activityTimeout)
    this.activityTimeout = setTimeout(this.ping.bind(this), this.config.activityTimeout || 60000)
  }

  accept (pdu) {
    this.appointNextPing()

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

    const encoding = message.encoding ? message.encoding.toLowerCase() : ''
    const content = message.content
    debug('content encoding %s, length %d', encoding, content.length)

    // assert(encoding === 'ucs2' && content.length <= 67 || encoding !== 'ucs2' && content.length <= 160, 'too long')
    // assert(encoding === 'binary' || (encoding === 'ucs2' && content.length <= 67) || (encoding !== 'ucs2' && content.length <= 160), 'too long')

    if (!this.bound) {
      throw new Error('can not submit in unbound state')
    }

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

    await this.submitTask(pdu)
  }

  async submitTask (pdu) {
    debug('submit task %j', pdu)

    assert(!this.isThrottled, 'throttle')

    return new Promise((resolve, reject) => {
      const remains = this.limiter.getTokensRemaining()
      debug('tokens remaining', remains)

      if (remains < 1) {
        reject(new Error('deny because no tokens remaining'))
        return
      }

      this.limiter.removeTokens(1, async(err, remaining) => {
        if (err) {
          reject(new Error('limiter rejects, submitted more tasks that limit'))
        } else {
          debug('limiter remaining tasks', remaining)
          if (remaining < 0) {
            reject(new Error('throttle'))
          } else {
            try {
              await this._submit(pdu)
              this.appointNextPing()
              resolve()
            } catch (e) {
              reject(e)
            }
          }
        }
      })
    })
  }

  checkResponseStatus (pdu) {
    let error = pdu.command_status
    debug('response status', pdu.command_status, smpp.errors[pdu.command_status])

    switch (error) {
      case 0:
        // Message successfully sent
        debug('confirmed msg id:', pdu.message_id)
        break
      case 0x058:
        // Throttling Error  - следует выдержать таймаут не менее одной минуты для тестового подключения и одной секунды – для коммерческого
        debug('Throttling Error!')
        this.isThrottled = true
        setTimeout(() => {
          this.isThrottled = false
        }, 60000)
        error = 'throttle'
        break
      case 0x014:
        // Used to indicate a resource error within the MC.
        // This may be interpreted as the maximum number of messages addressed to a single destination
        // or a global maximum of undelivered messages within the MC.
        // Message Queue Full  todo
        break
      case smpp.ESME_RINVDSTADR:
      case smpp.ESME_RINVDSTTON:
      case smpp.ESME_RINVDSTNPI:
      case smpp.ESME_RINVDSTADDRSUBUNIT:
        error = 'invalid address'
        break
    }

    return error
  }

  async _submit (pdu) {
    Object.assign(pdu, this.config.submit)

    assert(!this.isThrottled, 'throttle')
    debug('submitting pdu %O', pdu)

    await new Promise((resolve, reject) => {
      try {
        this.session.submit_sm(pdu, (resp) => {
          const error = this.checkResponseStatus(resp)
          if (error) {
            reject(Error(error))
          } else {
            resolve()
          }
        })
      } catch (e) {
        debug(e)
        reject(Error('submit error'))
      }
    })
  }

  async stop () {
    if (this.bound) {
      await this.unbind()
    }

    if (this.connected) {
      await this.disconnect()
    }
  }

  async unbind () {
    await new Promise((resolve) => {
      this.session.unbind(() => {
        resolve()
      })
    })
  }

  async disconnect () {
    await new Promise((resolve) => {
      this.session.close(() => {
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

module.exports.ESME = ESME

if (process.platform === 'win32') {
  debug('setting readline SIGINT')

  const readline = require('readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  rl.on('SIGINT', function () { process.emit('SIGINT') })
}
