# smpp-gateway
## Start

`node gateway.js`

Optional: `node tests/mock.js`

## Auto-patch SMPP module
Patch module `smpp` (during install)

smpp/defs.js: `var encoding = value.encoding||encodings.detect(message);`

## .env settings

```
   SMS_HTTP_MESSAGING_GATEWAY_URL = http://localhost:8090/messaging
   
   SMS_HTTP_SERVER_PORT = 8082
   SMS_HTTP_API_PASSWORD = passw0rd
   
   SMS_SMPP_SERVER_ADDRESS = 192.168.0.1
   SMS_SMPP_SERVER_PORT = 2775
   SMS_SMPP_SERVER_TIMEOUT = 3000
   SMS_SMPP_SERVER_TIMEOUT_LONGER = 5000
   SMS_SMPP_SYSTEM_ID = login
   SMS_SMPP_PASSWORD = passw0rd
   SMS_SMPP_SYSTEM_TYPE = test
   SMS_SMPP_INTERFACE_VERSION = 0x34
   
   SMS_SOURCE_ADDR = 1111
   SMS_SOURCE_ADDR_TON = 1
   SMS_SOURCE_ADDR_NPI = 1
   
   SMS_THROTTLE_COUNT = 2
   SMS_THROTTLE_PERIOD = 60000
   
   SMS_SMPP_ACTIVITY_TIMEOUT = 60000
```

## Example request

```
{
 "password": "passw0rd",
 "destination": "111111111",
 "text": "hello",
 "encoding": "ucs2",
 "udh": {
  "port": 37273
 }
}

curl -X POST -H "Content-Type: application/json" -d '{"password":"xxxx","destination":"111111111","content":"hello","encoding":"ucs2","udh1":{"port":37273}}' http://127.0.0.1:8080/sendSMS

```
