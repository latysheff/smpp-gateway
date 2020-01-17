const debug = require('debug')('sms:http')

const handleSendSMS = async(res, req, helpers) => {
  const { esme, password } = helpers

  if (!req.body) {
    respond(res, 400, 'error', 'bad request')
    return
  }

  const message = req.body
  debug('< request %j', message)

  if (req.body.password !== password) {
    respond(res, 403, 'error', 'bad password')
    return
  }

  if (!message.destination) {
    respond(res, 400, 'error', 'destination absent')
    return
  }

  if (!message.content) {
    respond(res, 400, 'error', 'content absent')
    return
  }

  try {
    await esme.sendMessage(message)
    respond(res, 200, 'OK', 'message sent')
  } catch (e) {
    respond(res, 503, 'error', e.message)
  }
}

function respond (res, httpStatus, status, message) {
  const response = { status, message }
  debug('> response %j', response)
  res.status(httpStatus)
  res.json(response).end()
}

module.exports.handleSendSMS = handleSendSMS
