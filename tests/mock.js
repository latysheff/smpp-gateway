require('dotenv').config({ path: '../.env' })

const debug = require('debug')('sms:mock')
const crypto = require('crypto')
const smpp = require('smpp')
const request = require('request')
const { RateLimiter } = require('limiter')

const {
  SMS_HTTP_MESSAGING_GATEWAY_URL,
  SMS_SMPP_SERVER_ADDRESS,
  SMS_SMPP_SERVER_PORT,
  SMS_SMPP_SYSTEM_ID,
  SMS_SMPP_PASSWORD,
  SMS_THROTTLE_COUNT,
  SMS_THROTTLE_PERIOD
} = process.env

const limiter = new RateLimiter(+SMS_THROTTLE_COUNT, +SMS_THROTTLE_PERIOD, true)

debug('mock started')

async function task (fn) {
  return new Promise((resolve, reject) => {
    const remains = limiter.getTokensRemaining()
    debug('tokens remaining', remains)

    if (remains < 1) {
      reject(new Error('deny because no tokens remaining'))
    } else {
      limiter.removeTokens(1, (err, remaining) => {
        if (err) {
          reject(new Error('limiter rejects, submitted more tasks that limit'))
        } else {
          debug('limiter remaining tasks', remaining)
          if (remaining < 0) {
            reject(new Error('limiter deny task'))
          } else {
            fn()
            resolve(remaining)
          }
        }
      })
    }
  })
}

function checkAsyncUserPass (user, password, callback) {
  if (user === SMS_SMPP_SYSTEM_ID && password === SMS_SMPP_PASSWORD) {
    callback()
  } else {
    callback(new Error('unauthorized'))
  }
}

const server = smpp.createServer((session) => {
  debug('session %s:%d', session.socket.remoteAddress, session.socket.remotePort)

  session.on('error', (err) => {
    debug('session error', err.message)
  })

  session.on('bind_transceiver', (pdu) => {
    session.pause()
    checkAsyncUserPass(pdu.system_id, pdu.password, (err) => {
      if (err) {
        debug('wrong credentials', pdu.system_id, pdu.password)

        session.send(pdu.response({
          command_status: smpp.ESME_RBINDFAIL
        }))
        /*
          ESME_RBINDFAIL:           0x000D,
          ESME_RINVPASWD:           0x000E,
          ESME_RINVSYSID:           0x000F,
         */
        session.close()
        return
      }

      debug('client [%s] is bound', pdu.system_id)

      session.send(pdu.response())
      session.resume()
    })
  })

  session.on('unbind', (pdu) => { session.send(pdu.response()) })

  session.on('enquire_link', (pdu) => {
    // if (count++ > 2)
    //   session.pause()
    session.send(pdu.response())
  })

  session.on('submit_sm', async(pdu) => {
    debug('received submit_sm %j', pdu)

    try {
      await task(() => {
        processSubmit(session, pdu)
      })
    } catch (e) {
      debug('reject submit', e.message)
      session.send(pdu.response({
        command_status: smpp.ESME_RTHROTTLED
      }))
    }
  })
})

function processSubmit (session, pdu) {
  // todo
  // debug('registered_delivery', pdu.registered_delivery)
  // const ack = smpp.REGISTERED_DELIVERY.DELIVERY_ACKNOWLEDGEMENT

  const message = {
    type: 'submit',
    // report: pdu.registered_delivery,
    dcs: pdu.data_coding,
    destination: {
      number: pdu.destination_addr,
      ton: pdu.dest_addr_ton,
      npi: pdu.dest_addr_npi
    },
    source: {
      number: pdu.source_addr,
      ton: pdu.source_addr_ton,
      npi: pdu.source_addr_npi
    },
    content: pdu.short_message.message
  }

  if (Buffer.isBuffer(pdu.short_message.udh)) {
    message.udh = pdu.short_message.udh.toString('hex')
  }

  debug('POST %s with JSON payload %j', SMS_HTTP_MESSAGING_GATEWAY_URL, message)

  if (!SMS_HTTP_MESSAGING_GATEWAY_URL) {
    const smppResp = {
      command_status: smpp.ESME_ROK,
      message_id: crypto.randomBytes(8).toString('hex')
    }
    debug('sending mocked SMPP response %j', smppResp)
    session.send(pdu.response(smppResp))

    return
  }

  request({
    uri: SMS_HTTP_MESSAGING_GATEWAY_URL,
    method: 'POST',
    json: true,
    body: message
  }, (error, resp, body) => {
    if (error) {
      debug('received HTTP error', error)
      session.send(pdu.response({
        command_status: smpp.ESME_RSYSERR
      }))
    } else {
      debug('received HTTP response %j', body)
      const smppResp = {
        command_status: smpp.ESME_ROK,
        message_id: crypto.randomBytes(8).toString('hex')
      }
      debug('sending SMPP response %j', smppResp)
      session.send(pdu.response(smppResp))
    }
  })
}

debug('SMPP server start on port', SMS_SMPP_SERVER_PORT, SMS_SMPP_SERVER_ADDRESS)
server.listen(SMS_SMPP_SERVER_PORT, SMS_SMPP_SERVER_ADDRESS)
// server.listen(12776)
