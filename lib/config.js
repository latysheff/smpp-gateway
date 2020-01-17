const {
  SMS_HTTP_SERVER_PORT,
  SMS_HTTP_API_PASSWORD,
  SMS_SMPP_SERVER_ADDRESS,
  SMS_SMPP_SERVER_PORT,
  SMS_SMPP_SERVER_TIMEOUT,
  SMS_SMPP_SERVER_TIMEOUT_LONGER,
  SMS_SMPP_SYSTEM_ID,
  SMS_SMPP_PASSWORD,
  SMS_SMPP_SYSTEM_TYPE,
  SMS_SMPP_INTERFACE_VERSION,
  SMS_SOURCE_ADDR,
  SMS_SOURCE_ADDR_TON,
  SMS_SOURCE_ADDR_NPI,
  SMS_THROTTLE_COUNT,
  SMS_THROTTLE_PERIOD,
  SMS_SMPP_ACTIVITY_TIMEOUT,
  SMS_ENQUIRE_LINK_TIMEOUT
} = process.env

const config = {
  server: {
    port: +SMS_HTTP_SERVER_PORT || 8080,
    password: SMS_HTTP_API_PASSWORD
  },
  connect: {
    host: SMS_SMPP_SERVER_ADDRESS || '127.0.0.1',
    port: SMS_SMPP_SERVER_PORT || 2775,
    reconnectTimeout: +SMS_SMPP_SERVER_TIMEOUT || 3000,
    reconnectTimeoutLonger: +SMS_SMPP_SERVER_TIMEOUT_LONGER || 5000
  },
  bind: {
    system_id: SMS_SMPP_SYSTEM_ID,
    password: SMS_SMPP_PASSWORD,
    system_type: SMS_SMPP_SYSTEM_TYPE,
    interface_version: SMS_SMPP_INTERFACE_VERSION || 0x34,
    addr_ton: 0,
    addr_npi: 0,
    address_range: ''
  },
  submit: {
    source_addr: SMS_SOURCE_ADDR,
    source_addr_ton: SMS_SOURCE_ADDR_TON,
    source_addr_npi: SMS_SOURCE_ADDR_NPI,
    dest_addr_ton: 1,
    dest_addr_npi: 1
  },
  throttle: {
    count: +SMS_THROTTLE_COUNT || 2,
    period: +SMS_THROTTLE_PERIOD || 60000
  },
  activityTimeout: +SMS_SMPP_ACTIVITY_TIMEOUT || 60000,
  pingTimeout: +SMS_ENQUIRE_LINK_TIMEOUT || 8000
}

module.exports = config
