const crypto = require('crypto')
const smpp = require('smpp')
const { RateLimiter } = require('limiter')

const {
  SMPP_SMPP_SERVER_ADDRESS,
  SMPP_SMPP_SERVER_PORT,
  SMPP_SYSTEM_ID,
  SMPP_PASSWORD,
  SMPP_THROTTLE_COUNT,
  SMPP_THROTTLE_PERIOD
} = process.env

const config = {
  address: SMPP_SMPP_SERVER_ADDRESS || '127.0.0.1',
  port: SMPP_SMPP_SERVER_PORT || 2775,
  throttle_count: SMPP_THROTTLE_COUNT || 10,
  throttle_period: SMPP_THROTTLE_PERIOD || 60000,
  system_id: SMPP_SYSTEM_ID || 'login',
  password: SMPP_PASSWORD || 'password'
}

console.log('config:', config)

const limiter = new RateLimiter(config.throttle_count, config.throttle_period, true)

async function task (fn) {
  return new Promise((resolve, reject) => {
    const remains = limiter.getTokensRemaining()
    console.log('tokens remaining', remains)

    if (remains < 1) {
      reject(new Error('deny because no tokens remaining'))
    } else {
      limiter.removeTokens(1, (err, remaining) => {
        if (err) {
          reject(new Error('limiter rejects, submitted more tasks that limit'))
        } else {
          console.log('limiter remaining tasks', remaining)
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
  if (user === config.system_id && password === config.password) {
    callback()
  } else {
    callback(new Error('unauthorized'))
  }
}

const server = smpp.createServer((session) => {
  console.log('session %s:%d', session.socket.remoteAddress, session.socket.remotePort)

  session.on('error', (err) => {
    console.log('session error', err.message)
  })

  session.on('bind_transceiver', (pdu) => {
    session.pause()
    checkAsyncUserPass(pdu.system_id, pdu.password, (err) => {
      if (err) {
        console.log('wrong credentials: [%s]:[%s]', pdu.system_id, pdu.password)

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

      console.log('client [%s] is bound', pdu.system_id)

      session.send(pdu.response())
      session.resume()
    })
  })

  session.on('unbind', (pdu) => { session.send(pdu.response()) })

  session.on('enquire_link', (pdu) => {
    if (Math.random() < 0.8) {
      session.send(pdu.response())
    } else {
      console.log('emulate enquire_link timeout')
    }
  })

  session.on('submit_sm', async (pdu) => {
    console.log('received submit_sm %j', pdu)

    try {
      await task(() => {
        processSubmit(session, pdu)
      })
    } catch (e) {
      console.log('reject submit', e.message)
      session.send(pdu.response({
        command_status: smpp.ESME_RTHROTTLED
      }))
    }

    setTimeout(() => {
      session.deliver_sm({})
    }, 1000)
  })
})

function processSubmit (session, pdu) {
  // todo
  // console.log('registered_delivery', pdu.registered_delivery)
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

  const smppResp = {
    command_status: smpp.ESME_ROK,
    message_id: crypto.randomBytes(8).toString('hex')
  }
  console.log('sending mock SMPP response %j', smppResp)
  session.send(pdu.response(smppResp))
}

server.listen(config.port, config.address, () => {
  console.log('mock SMPP server started on port', config.address, config.port)
})
