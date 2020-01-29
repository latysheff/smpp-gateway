const debug = require('debug')('smpp:gateway')

const express = require('express')
const bodyParser = require('body-parser')

module.exports = function (esme) {
  const router = express.Router()

  router.use(bodyParser.json())

  router.post('/', async(req, res, next) => {
    const message = req.body
    debug('< request %j', message)
    try {
      await esme.sendMessage(message)
      res.status(200).json({ success: true }).end()
    } catch (e) {
      next(e)
    }
  })

  router.use((err, req, res, next) => {
    // debug(err)
    // debug('%j', err)

    const response = {
      success: false,
      code: err.code,
      message: err.message
    }

    debug('> response %j', response)

    res.status(err.code === 'ERR_ESME_VALIDATION' ? 400 : 500).json(response).end()
  })

  return router
}
