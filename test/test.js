'use strict'

const fs = require('fs')
const path = require('path')
const test = require('tape')
const Demodulator = require('../')

const DATA_LEN = (16 * 16384) // 256k
const PREAMBLE_US = 8         // microseconds
const LONG_MSG_BITS = 112
const FULL_LEN = PREAMBLE_US + LONG_MSG_BITS

const dataLen = DATA_LEN + (FULL_LEN - 1) * 4

const fixtureFile = path.join(__dirname, 'fixture.bin')

test(function (t) {
  const messages = [
    '8d45ac2d9904d910613f94ba81b5',
    '5d45ac2da5e9cb',
    '8d45ac2d583561285c4fa686fcdc',
    'a00006979b580030400000df4221',
    '5d45ac2da5e9cb',
    '5d45ac2da5e9cb',
    '02a186b39408d0',
    '200006b31828c8'
  ]

  t.plan(messages.length)

  const demodulator = new Demodulator()
  const file = fs.createReadStream(fixtureFile)

  file.on('readable', function () {
    let data
    while ((data = file.read(dataLen)) !== null) {
      if (data.length < dataLen) return
      demodulator.process(data, data.length, onMsg)
    }
  })

  function onMsg (msg) {
    const msghex = Buffer.from(msg.msg.buffer, 0, msg.msgbits / 8).toString('hex')
    t.equal(msghex, messages.shift())
  }
})
