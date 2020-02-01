const smpp = require('smpp')
const { UDH } = require('sms-3gpp')

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

function encodeUdh (udh) {
  return UDH.encode(udh)
}

module.exports = { deliveryFlags, encodeUdh }
