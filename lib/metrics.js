const express = require('express')
const prometheus = require('prom-client')

const METRICS = 'connecting,connect,close,reconnecting,binding,bound,send,receive'

module.exports = function (esme) {
  const router = express.Router()
  setMetrics(esme)

  router.get('/', (req, res, next) => {
    res.end(prometheus.register.metrics())
  })

  return router
}

function setMetrics (esme) {
  const metrics = {}

  METRICS.split(',').forEach(name => {
    metrics[name] = new prometheus.Counter({ name: 'esme_' + name, help: 'esme_' + name + '_help' })
  })
  metrics.error = new prometheus.Counter({ name: 'esme_error', help: 'esme_error_help', labelNames: ['code'] })

  esme.on('error', (err) => {
    const code = err.code || 'ERR_UNKNOWN'
    metrics.error.inc({ code })
  })

  esme.on('connecting', () => {
    metrics.connecting.inc()
  })

  esme.on('connect', () => {
    metrics.connect.inc()
  })

  esme.on('close', () => {
    metrics.close.inc()
  })

  esme.on('binding', () => {
    metrics.binding.inc()
  })

  esme.on('reconnecting', () => {
    metrics.reconnecting.inc()
  })

  esme.on('bound', () => {
    metrics.bound.inc()
  })

  esme.on('send', () => {
    metrics.send.inc()
  })

  esme.on('receive', () => {
    metrics.receive.inc()
  })
}
