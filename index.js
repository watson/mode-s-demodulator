'use strict'

const ICAO_CACHE_LEN = 1024 // Power of two required
const LONG_MSG_BYTES = 112 / 8
const UNIT_FEET = 0
const UNIT_METERS = 1

const PREAMBLE_US = 8       // microseconds
const LONG_MSG_BITS = 112
const SHORT_MSG_BITS = 56
const FULL_LEN = PREAMBLE_US + LONG_MSG_BITS

const ICAO_CACHE_TTL = 60   // Time to live of cached addresses.

const maglut = new Uint16Array(129 * 129 * 2)
let maglutInitialized = false

exports.init = init
exports.computeMagnitudeVector = computeMagnitudeVector
exports.detect = detect
exports.decode = decode

exports.UNIT_FEET = UNIT_FEET
exports.UNIT_METERS = UNIT_METERS

function memcpy (dst, dstOffset, src, srcOffset, length) {
  for (let i = srcOffset; i < length; i++) {
    dst[dstOffset + i] = src[i]
  }
}

// The struct we use to store information about a decoded message
function Message () {
  // Generic fields
  this.msg = null                    // Binary message
  this.msgbits = null                // Number of bits in message
  this.msgtype = null                // Downlink format #
  this.crcok = false                 // True if CRC was valid
  this.crc = null                    // Message CRC
  this.errorbit = null               // Bit corrected. -1 if no bit corrected.
  this.aa1 = null                    // ICAO Address byte 1
  this.aa2 = null                    // ICAO Address byte 2
  this.aa3 = null                    // ICAO Address byte 3
  this.phaseCorrected = false        // True if phase correction was applied.

  // DF 11
  this.ca = null                     // Responder capabilities.

  // DF 17
  this.metype = null                 // Extended squitter message type.
  this.mesub = null                  // Extended squitter message subtype.
  this.headingIsValid = null
  this.heading = null
  this.aircraftType = null
  this.fflag = null                  // 1 = Odd, 0 = Even CPR message.
  this.tflag = null                  // UTC synchronized?
  this.rawLatitude = null            // Non decoded latitude
  this.rawLongitude = null           // Non decoded longitude
  this.flight = new Int8Array(8)     // 8 chars flight number.
  this.ewDir = null                  // 0 = East, 1 = West.
  this.ewVelocity = null             // E/W velocity.
  this.nsDir = null                  // 0 = North, 1 = South.
  this.nsVelocity = null             // N/S velocity.
  this.vertRateSource = null         // Vertical rate source.
  this.vertRateSign = null           // Vertical rate sign.
  this.vertRate = null               // Vertical rate.
  this.velocity = null               // Computed from EW and NS velocity.

  // DF4, DF5, DF20, DF21
  this.fs = null                     // Flight status for DF4,5,20,21
  this.dr = null                     // Request extraction of downlink request.
  this.um = null                     // Request extraction of downlink request.
  this.identity = null               // 13 bits identity (Squawk).

  // Fields used by multiple message types.
  this.altitude = null
  this.unit = null
}

// =============================== Initialization ===========================

function init () {
  const self = {
    // Internal state
    icaoCache: new Uint32Array(ICAO_CACHE_LEN * 2), // Recently seen ICAO addresses cache

    // Configuration
    fixErrors: true,   // Single bit error correction if true
    aggressive: false, // Aggressive detection algorithm
    checkCrc: true     // Only display messages with good CRC
  }

  // Populate the I/Q -> Magnitude lookup table. It is used because sqrt or
  // round may be expensive and may vary a lot depending on the libc used.
  //
  // We scale to 0-255 range multiplying by 1.4 in order to ensure that every
  // different I/Q pair will result in a different magnitude value, not losing
  // any resolution.
  if (!maglutInitialized) {
    for (let i = 0; i <= 128; i++) {
      for (let q = 0; q <= 128; q++) {
        maglut[i * 129 + q] = Math.round(Math.sqrt(i * i + q * q) * 360)
      }
    }
    maglutInitialized = true
  }

  return self
}

// ===================== Mode S detection and decoding  =====================

// Parity table for MODE S Messages.
//
// The table contains 112 elements, every element corresponds to a bit set in
// the message, starting from the first bit of actual data after the preamble.
//
// For messages of 112 bit, the whole table is used. For messages of 56 bits
// only the last 56 elements are used.
//
// The algorithm is as simple as xoring all the elements in this table for
// which the corresponding bit on the message is set to 1.
//
// The latest 24 elements in this table are set to 0 as the checksum at the end
// of the message should not affect the computation.
//
// Note: this function can be used with DF11 and DF17, other modes have the CRC
// xored with the sender address as they are reply to interrogations, but a
// casual listener can't split the address from the checksum.
// uint32_t mode_s_checksum_table[] = {
const checksumTable = new Uint32Array([
  0x3935ea, 0x1c9af5, 0xf1b77e, 0x78dbbf, 0xc397db, 0x9e31e9, 0xb0e2f0, 0x587178,
  0x2c38bc, 0x161c5e, 0x0b0e2f, 0xfa7d13, 0x82c48d, 0xbe9842, 0x5f4c21, 0xd05c14,
  0x682e0a, 0x341705, 0xe5f186, 0x72f8c3, 0xc68665, 0x9cb936, 0x4e5c9b, 0xd8d449,
  0x939020, 0x49c810, 0x24e408, 0x127204, 0x093902, 0x049c81, 0xfdb444, 0x7eda22,
  0x3f6d11, 0xe04c8c, 0x702646, 0x381323, 0xe3f395, 0x8e03ce, 0x4701e7, 0xdc7af7,
  0x91c77f, 0xb719bb, 0xa476d9, 0xadc168, 0x56e0b4, 0x2b705a, 0x15b82d, 0xf52612,
  0x7a9309, 0xc2b380, 0x6159c0, 0x30ace0, 0x185670, 0x0c2b38, 0x06159c, 0x030ace,
  0x018567, 0xff38b7, 0x80665f, 0xbfc92b, 0xa01e91, 0xaff54c, 0x57faa6, 0x2bfd53,
  0xea04ad, 0x8af852, 0x457c29, 0xdd4410, 0x6ea208, 0x375104, 0x1ba882, 0x0dd441,
  0xf91024, 0x7c8812, 0x3e4409, 0xe0d800, 0x706c00, 0x383600, 0x1c1b00, 0x0e0d80,
  0x0706c0, 0x038360, 0x01c1b0, 0x00e0d8, 0x00706c, 0x003836, 0x001c1b, 0xfff409,
  0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000,
  0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000,
  0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000, 0x000000
])

function checksum (msg, bits) {
  let crc = 0
  const offset = bits === 112 ? 0 : 112 - 56

  for (let j = 0; j < bits; j++) {
    const byte = (j / 8) >> 0 // Ignore remainder
    const bit = j % 8
    const bitmask = 1 << (7 - bit)

    // If bit is set, xor with corresponding table entry.
    if (msg[byte] & bitmask) crc ^= checksumTable[j + offset]
  }
  return crc // 24 bit checksum.
}

// Given the Downlink Format (DF) of the message, return the message length in
// bits.
function msgLenByType (type) {
  if (type === 16 || type === 17 ||
      type === 19 || type === 20 ||
      type === 21) {
    return LONG_MSG_BITS
  } else {
    return SHORT_MSG_BITS
  }
}

// Try to fix single bit errors using the checksum. On success modifies the
// original buffer with the fixed version, and returns the position of the
// error bit. Otherwise if fixing failed -1 is returned.
function fixSingleBitErrors (msg, bits) {
  const aux = new Uint8Array(LONG_MSG_BITS / 8)

  for (let j = 0; j < bits; j++) {
    const byte = (j / 8) >> 0 // Ignore remainder
    const bitmask = 1 << (7 - (j % 8))
    let crc1, crc2

    memcpy(aux, 0, msg, 0, bits / 8)
    aux[byte] ^= bitmask // Flip j-th bit.

    crc1 = (aux[(bits / 8) - 3] << 16) |
           (aux[(bits / 8) - 2] << 8) |
            aux[(bits / 8) - 1]
    crc2 = checksum(aux, bits)

    if (crc1 === crc2) {
      // The error is fixed. Overwrite the original buffer with the
      // corrected sequence, and returns the error bit position.
      memcpy(msg, 0, aux, 0, bits / 8)

      return j
    }
  }
  return -1
}

// Similar to fixSingleBitErrors() but try every possible two bit
// combination. This is very slow and should be tried only against DF17
// messages that don't pass the checksum, and only in Aggressive Mode.
function fixTwoBitsErrors (msg, bits) {
  const aux = new Uint8Array(LONG_MSG_BITS / 8)

  for (let j = 0; j < bits; j++) {
    const byte1 = (j / 8) >> 0 // Ignore remainder
    const bitmask1 = 1 << (7 - (j % 8))

    // Don't check the same pairs multiple times, so i starts from j+1
    for (let i = j + 1; i < bits; i++) {
      const byte2 = (i / 8) >> 0 // Ignore remainder
      const bitmask2 = 1 << (7 - (i % 8))
      let crc1, crc2

      memcpy(aux, 0, msg, 0, bits / 8)

      aux[byte1] ^= bitmask1 // Flip j-th bit.
      aux[byte2] ^= bitmask2 // Flip i-th bit.

      crc1 = (aux[(bits / 8) - 3] << 16) |
             (aux[(bits / 8) - 2] << 8) |
              aux[(bits / 8) - 1]
      crc2 = checksum(aux, bits)

      if (crc1 === crc2) {
        // The error is fixed. Overwrite the original buffer with the
        // corrected sequence, and returns the error bit position.
        memcpy(msg, 0, aux, 0, bits / 8)
        // We return the two bits as a 16 bit integer by shifting 'i'
        // on the left. This is possible since 'i' will always be
        // non-zero because i starts from j+1.
        return j | (i << 8)
      }
    }
  }
  return -1
}

// Hash the ICAO address to index our cache of ICAO_CACHE_LEN elements,
// that is assumed to be a power of two.
//
// FIXME: This doesn't give the exact same result as its C counterpart as the C
// version operates on tru uint8_t numbers. But it's pretty close... seems to
// just be off by one. I.e. if a = 4566061, then the return value is 100, but
// it should be 101
function icaoCacheHasAddr (a) {
  // The following three rounds wil make sure that every bit affects every
  // output bit with ~ 50% of probability.
  a = ((((a >>> 16) ^ a) * 0x45d9f3b) & 0xffffffff) >>> 0
  a = ((((a >>> 16) ^ a) * 0x45d9f3b) & 0xffffffff) >>> 0
  a = (((a >>> 16) ^ a) & 0xffffffff) >>> 0
  return a & (ICAO_CACHE_LEN - 1)
}

// Add the specified entry to the cache of recently seen ICAO addresses. Note
// that we also add a timestamp so that we can make sure that the entry is only
// valid for ICAO_CACHE_TTL seconds.
function addRecentlySeenIcaoAddr (self, addr) {
  const h = icaoCacheHasAddr(addr)
  self.icaoCache[h * 2] = addr
  const time = (Date.now() / 1000) >> 0
  self.icaoCache[h * 2 + 1] = time
}

// Returns 1 if the specified ICAO address was seen in a DF format with proper
// checksum (not xored with address) no more than * ICAO_CACHE_TTL
// seconds ago. Otherwise returns 0.
function icaoAddrWasRecentlySeen (self, addr) {
  const h = icaoCacheHasAddr(addr)
  const a = self.icaoCache[h * 2]
  const t = self.icaoCache[h * 2 + 1]

  const time = (Date.now() / 1000) >> 0
  return a && a === addr && time - t <= ICAO_CACHE_TTL
}

// If the message type has the checksum xored with the ICAO address, try to
// brute force it using a list of recently seen ICAO addresses.
//
// Do this in a brute-force fashion by xoring the predicted CRC with the
// address XOR checksum field in the message. This will recover the address: if
// we found it in our cache, we can assume the message is ok.
//
// This function expects mm.msgtype and mm.msgbits to be correctly populated
// by the caller.
//
// On success the correct ICAO address is stored in the Message object in
// the aa3, aa2, and aa1 fiedls.
//
// If the function successfully recovers a message with a correct checksum it
// returns 1. Otherwise 0 is returned.
function bruteForceAp (self, msg, mm) {
  if (mm.msgtype === 0 ||         // Short air surveillance
      mm.msgtype === 4 ||         // Surveillance, altitude reply
      mm.msgtype === 5 ||         // Surveillance, identity reply
      mm.msgtype === 16 ||        // Long Air-Air survillance
      mm.msgtype === 20 ||        // Comm-A, altitude request
      mm.msgtype === 21 ||        // Comm-A, identity request
      mm.msgtype === 24) {        // Comm-C ELM
    const aux = new Uint8Array(LONG_MSG_BYTES)
    const lastbyte = (mm.msgbits / 8) - 1
    let addr, crc

    // Work on a copy.
    memcpy(aux, 0, msg, 0, mm.msgbits / 8)

    // Compute the CRC of the message and XOR it with the AP field so that
    // we recover the address, because:
    //
    // (ADDR xor CRC) xor CRC = ADDR.
    crc = checksum(aux, mm.msgbits)
    aux[lastbyte] ^= crc & 0xff
    aux[lastbyte - 1] ^= (crc >> 8) & 0xff
    aux[lastbyte - 2] ^= (crc >> 16) & 0xff

    // If the obtained address exists in our cache we consider the message
    // valid.
    addr = aux[lastbyte] | (aux[lastbyte - 1] << 8) | (aux[lastbyte - 2] << 16)
    if (icaoAddrWasRecentlySeen(self, addr)) {
      mm.aa1 = aux[lastbyte - 2]
      mm.aa2 = aux[lastbyte - 1]
      mm.aa3 = aux[lastbyte]
      return true
    }
  }

  return false
}

// Decode the 13 bit AC altitude field (in DF 20 and others). Returns the
// altitude, and set 'unit' to either UNIT_METERS or MDOES_UNIT_FEETS.
function decodeAc13Field (msg) {
  const mBit = msg[3] & (1 << 6)
  const qBit = msg[3] & (1 << 4)
  let unit

  if (!mBit) {
    unit = UNIT_FEET
    if (qBit) {
      // N is the 11 bit integer resulting from the removal of bit Q and M
      const n = ((msg[2] & 31) << 6) |
                ((msg[3] & 0x80) >> 2) |
                ((msg[3] & 0x20) >> 1) |
                 (msg[3] & 15)
      // The final altitude is due to the resulting number multiplied by
      // 25, minus 1000.
      return [n * 25 - 1000, unit]
    } else {
      // TODO: Implement altitude where Q=0 and M=0
    }
  } else {
    unit = UNIT_METERS
    // TODO: Implement altitude when meter unit is selected.
  }
  return [0, unit]
}

// Decode the 12 bit AC altitude field (in DF 17 and others). Returns the
// altitude or 0 if it can't be decoded.
function decodeAc12Field (msg) {
  const qBit = msg[5] & 1

  if (qBit) {
    // N is the 11 bit integer resulting from the removal of bit Q
    const n = ((msg[5] >> 1) << 4) | ((msg[6] & 0xF0) >> 4)
    // The final altitude is due to the resulting number multiplied by 25,
    // minus 1000.
    return [n * 25 - 1000, UNIT_FEET]
  }
}

const aisCharset = '?ABCDEFGHIJKLMNOPQRSTUVWXYZ????? ???????????????0123456789??????'

// Decode a raw Mode S message demodulated as a stream of bytes by
// detect(), and split it into fields populating a Message object.
function decode (self, mm, msg) {
  let crc2 // Computed CRC, used to verify the message CRC.

  mm.msg = msg

  // Get the message type ASAP as other operations depend on this
  mm.msgtype = msg[0] >> 3    // Downlink Format
  mm.msgbits = msgLenByType(mm.msgtype)

  // CRC is always the last three bytes.
  mm.crc = (msg[(mm.msgbits / 8) - 3] << 16) |
           (msg[(mm.msgbits / 8) - 2] << 8) |
            msg[(mm.msgbits / 8) - 1]
  crc2 = checksum(msg, mm.msgbits)

  // Check CRC and fix single bit errors using the CRC when possible (DF 11 and 17).
  mm.errorbit = -1  // No error
  mm.crcok = mm.crc === crc2

  if (!mm.crcok && self.fixErrors && (mm.msgtype === 11 || mm.msgtype === 17)) {
    if ((mm.errorbit = fixSingleBitErrors(msg, mm.msgbits)) !== -1) {
      mm.crc = checksum(msg, mm.msgbits)
      mm.crcok = true
    } else if (self.aggressive && mm.msgtype === 17 &&
               (mm.errorbit = fixTwoBitsErrors(msg, mm.msgbits)) !== -1) {
      mm.crc = checksum(msg, mm.msgbits)
      mm.crcok = true
    }
  }

  // Note that most of the other computation happens *after* we fix the
  // single bit errors, otherwise we would need to recompute the fields
  // again.
  mm.ca = msg[0] & 7            // Responder capabilities.

  // ICAO address
  mm.aa1 = msg[1]
  mm.aa2 = msg[2]
  mm.aa3 = msg[3]

  // DF 17 type (assuming this is a DF17, otherwise not used)
  mm.metype = msg[4] >> 3       // Extended squitter message type.
  mm.mesub = msg[4] & 7         // Extended squitter message subtype.

  // Fields for DF4,5,20,21
  mm.fs = msg[0] & 7            // Flight status for DF4,5,20,21
  mm.dr = msg[1] >> 3 & 31      // Request extraction of downlink request.
  mm.um = ((msg[1] & 7) << 3) | // Request extraction of downlink request.
            msg[2] >> 5

  // In the squawk (identity) field bits are interleaved like that (message
  // bit 20 to bit 32):
  //
  // C1-A1-C2-A2-C4-A4-ZERO-B1-D1-B2-D2-B4-D4
  //
  // So every group of three bits A, B, C, D represent an integer from 0 to
  // 7.
  //
  // The actual meaning is just 4 octal numbers, but we convert it into a
  // base ten number tha happens to represent the four octal numbers.
  //
  // For more info: http://en.wikipedia.org/wiki/Gillham_code
  {
    const a = ((msg[3] & 0x80) >> 5) |
              ((msg[2] & 0x02) >> 0) |
              ((msg[2] & 0x08) >> 3)
    const b = ((msg[3] & 0x02) << 1) |
              ((msg[3] & 0x08) >> 2) |
              ((msg[3] & 0x20) >> 5)
    const c = ((msg[2] & 0x01) << 2) |
              ((msg[2] & 0x04) >> 1) |
              ((msg[2] & 0x10) >> 4)
    const d = ((msg[3] & 0x01) << 2) |
              ((msg[3] & 0x04) >> 1) |
              ((msg[3] & 0x10) >> 4)
    mm.identity = a * 1000 + b * 100 + c * 10 + d
  }

  // DF 11 & 17: try to populate our ICAO addresses whitelist. DFs with an AP
  // field (xored addr and crc), try to decode it.
  if (mm.msgtype !== 11 && mm.msgtype !== 17) {
    // Check if we can check the checksum for the Downlink Formats where
    // the checksum is xored with the aircraft ICAO address. We try to
    // brute force it using a list of recently seen aircraft addresses.
    if (bruteForceAp(self, msg, mm)) {
      // We recovered the message, mark the checksum as valid.
      mm.crcok = true
    } else {
      mm.crcok = false
    }
  } else {
    // If this is DF 11 or DF 17 and the checksum was ok, we can add this
    // address to the list of recently seen addresses.
    if (mm.crcok && mm.errorbit === -1) {
      const addr = (mm.aa1 << 16) | (mm.aa2 << 8) | mm.aa3
      addRecentlySeenIcaoAddr(self, addr)
    }
  }

  // Decode 13 bit altitude for DF0, DF4, DF16, DF20
  if (mm.msgtype === 0 || mm.msgtype === 4 ||
      mm.msgtype === 16 || mm.msgtype === 20) {
    const r = decodeAc13Field(msg)
    mm.altitude = r[0]
    mm.unit = r[1]
  }

  // Decode extended squitter specific stuff.
  if (mm.msgtype === 17) {
    // Decode the extended squitter message.

    if (mm.metype >= 1 && mm.metype <= 4) {
      // Aircraft Identification and Category
      mm.aircraftType = mm.metype - 1
      mm.flight[0] = (aisCharset)[msg[5] >> 2]
      mm.flight[1] = aisCharset[((msg[5] & 3) << 4) | (msg[6] >> 4)]
      mm.flight[2] = aisCharset[((msg[6] & 15) << 2) | (msg[7] >> 6)]
      mm.flight[3] = aisCharset[msg[7] & 63]
      mm.flight[4] = aisCharset[msg[8] >> 2]
      mm.flight[5] = aisCharset[((msg[8] & 3) << 4) | (msg[9] >> 4)]
      mm.flight[6] = aisCharset[((msg[9] & 15) << 2) | (msg[10] >> 6)]
      mm.flight[7] = aisCharset[msg[10] & 63]
    } else if (mm.metype >= 9 && mm.metype <= 18) {
      // Airborne position Message
      mm.fflag = msg[6] & (1 << 2)
      mm.tflag = msg[6] & (1 << 3)
      const r = decodeAc12Field(msg)
      if (r) {
        mm.altitude = r[0]
        mm.unit = r[1]
      }
      mm.rawLatitude = ((msg[6] & 3) << 15) |
                          (msg[7] << 7) |
                          (msg[8] >> 1)
      mm.rawLongitude = ((msg[8] & 1) << 16) |
                           (msg[9] << 8) |
                           msg[10]
    } else if (mm.metype === 19 && mm.mesub >= 1 && mm.mesub <= 4) {
      // Airborne Velocity Message
      if (mm.mesub === 1 || mm.mesub === 2) {
        mm.ewDir = (msg[5] & 4) >> 2
        mm.ewVelocity = ((msg[5] & 3) << 8) | msg[6]
        mm.nsDir = (msg[7] & 0x80) >> 7
        mm.nsVelocity = ((msg[7] & 0x7f) << 3) | ((msg[8] & 0xe0) >> 5)
        mm.vertRateSource = (msg[8] & 0x10) >> 4
        mm.vertRateSign = (msg[8] & 0x8) >> 3
        mm.vertRate = ((msg[8] & 7) << 6) | ((msg[9] & 0xfc) >> 2)
        // Compute velocity and angle from the two speed components
        mm.velocity = Math.sqrt(mm.nsVelocity * mm.nsVelocity +
                                mm.ewVelocity * mm.ewVelocity)
        if (mm.velocity) {
          let ewv = mm.ewVelocity
          let nsv = mm.nsVelocity
          let heading // FIXME: This is supposed to be a double in C. Can we handle that?

          if (mm.ewDir) ewv *= -1
          if (mm.nsDir) nsv *= -1
          heading = Math.atan2(ewv, nsv)

          // Convert to degrees.
          mm.heading = heading * 360 / (Math.PI * 2) // TODO: should we ignore remainder?
          // We don't want negative values but a 0-360 scale.
          if (mm.heading < 0) mm.heading += 360
        } else {
          mm.heading = 0
        }
      } else if (mm.mesub === 3 || mm.mesub === 4) {
        mm.headingIsValid = msg[5] & (1 << 2)
        mm.heading = (360.0 / 128) * (((msg[5] & 3) << 5) | // TODO: Should we ignore remainder
                                      (msg[6] >> 3))
      }
    }
  }
  mm.phaseCorrected = false // Set to true by the caller if needed.
}

// Turn I/Q samples pointed by `data` into the magnitude vector pointed by `mag`
function computeMagnitudeVector (data, mag, size, hackrf) {
  // Compute the magnitude vector. It's just SQRT(I^2 + Q^2), but we rescale
  // to the 0-255 range to exploit the full resolution.
  if (hackrf) {
    for (let j = 0; j < size; j += 2) {
      let i = data.readInt8(j)
      let q = data.readInt8(j + 1)

      if (i < 0) i = -i
      if (q < 0) q = -q

      mag[j / 2] = maglut[i * 129 + q]
    }
  } else {
    for (let j = 0; j < size; j += 2) {
      let i = data[j] - 127
      let q = data[j + 1] - 127

      if (i < 0) i = -i
      if (q < 0) q = -q
      mag[j / 2] = maglut[i * 129 + q]
    }
  }
}

// Return -1 if the message is out of fase left-side
// Return  1 if the message is out of fase right-size
// Return  0 if the message is not particularly out of phase.
//
// Note: this function will access mag[-1], so the caller should make sure to
// call it only if we are not at the start of the current buffer.
function detectOutOfPhase (mag, offset) {
  if (mag[offset + 3] > mag[offset + 2] / 3) return 1
  if (mag[offset + 10] > mag[offset + 9] / 3) return 1
  if (mag[offset + 6] > mag[offset + 7] / 3) return -1
  if (mag[offset + -1] > mag[offset + 1] / 3) return -1
  return 0
}

// This function does not really correct the phase of the message, it just
// applies a transformation to the first sample representing a given bit:
//
// If the previous bit was one, we amplify it a bit.
// If the previous bit was zero, we decrease it a bit.
//
// This simple transformation makes the message a bit more likely to be
// correctly decoded for out of phase messages:
//
// When messages are out of phase there is more uncertainty in sequences of the
// same bit multiple times, since 11111 will be transmitted as continuously
// altering magnitude (high, low, high, low...)
//
// However because the message is out of phase some part of the high is mixed
// in the low part, so that it is hard to distinguish if it is a zero or a one.
//
// However when the message is out of phase passing from 0 to 1 or from 1 to 0
// happens in a very recognizable way, for instance in the 0 -> 1 transition,
// magnitude goes low, high, high, low, and one of of the two middle samples
// the high will be *very* high as part of the previous or next high signal
// will be mixed there.
//
// Applying our simple transformation we make more likely if the current bit is
// a zero, to detect another zero. Symmetrically if it is a one it will be more
// likely to detect a one because of the transformation. In this way similar
// levels will be interpreted more likely in the correct way.
function applyPhaseCorrection (mag, offset) {
  // Move ahead 16 to skip preamble.
  for (let j = 16; j < (LONG_MSG_BITS - 1) * 2; j += 2) {
    if (mag[offset + j] > mag[offset + j + 1]) {
      // One
      mag[offset + j + 2] = (mag[offset + j + 2] * 5) / 4
    } else {
      // Zero
      mag[offset + j + 2] = (mag[offset + j + 2] * 4) / 5
    }
  }
}

// Detect a Mode S messages inside the magnitude buffer pointed by 'mag' and of
// size 'maglen' bytes. Every detected Mode S message is convert it into a
// stream of bits and passed to the function to display it.
function detect (self, mag, maglen, cb) {
  const bits = new Uint8Array(LONG_MSG_BITS)
  const msg = new Uint8Array(LONG_MSG_BITS / 2)
  const aux = new Uint16Array(LONG_MSG_BITS * 2)
  let useCorrection = false

  // The Mode S preamble is made of impulses of 0.5 microseconds at the
  // following time offsets:
  //
  // 0   - 0.5 usec: first impulse.
  // 1.0 - 1.5 usec: second impulse.
  // 3.5 - 4   usec: third impulse.
  // 4.5 - 5   usec: last impulse.
  //
  // Since we are sampling at 2 Mhz every sample in our magnitude vector is
  // 0.5 usec, so the preamble will look like this, assuming there is an
  // impulse at offset 0 in the array:
  //
  // 0   -----------------
  // 1   -
  // 2   ------------------
  // 3   --
  // 4   -
  // 5   --
  // 6   -
  // 7   ------------------
  // 8   --
  // 9   -------------------
  for (let j = 0; j < maglen - FULL_LEN * 2; j++) {
    let low, high, delta, i, errors
    let goodMessage = false

    if (!useCorrection) {
      // First check of relations between the first 10 samples representing a
      // valid preamble. We don't even investigate further if this simple
      // test is not passed.
      if (!(mag[j] > mag[j + 1] &&
          mag[j + 1] < mag[j + 2] &&
          mag[j + 2] > mag[j + 3] &&
          mag[j + 3] < mag[j] &&
          mag[j + 4] < mag[j] &&
          mag[j + 5] < mag[j] &&
          mag[j + 6] < mag[j] &&
          mag[j + 7] > mag[j + 8] &&
          mag[j + 8] < mag[j + 9] &&
          mag[j + 9] > mag[j + 6])) {
        continue
      }

      // The samples between the two spikes must be < than the average of the
      // high spikes level. We don't test bits too near to the high levels as
      // signals can be out of phase so part of the energy can be in the near
      // samples.
      high = (mag[j] + mag[j + 2] + mag[j + 7] + mag[j + 9]) / 6
      if (mag[j + 4] >= high ||
          mag[j + 5] >= high) {
        continue
      }

      // Similarly samples in the range 11-14 must be low, as it is the space
      // between the preamble and real data. Again we don't test bits too
      // near to high levels, see above.
      if (mag[j + 11] >= high ||
          mag[j + 12] >= high ||
          mag[j + 13] >= high ||
          mag[j + 14] >= high) {
        continue
      }
    }

    // If the previous attempt with this message failed, retry using
    // magnitude correction.
    if (useCorrection) {
      memcpy(aux, 0, mag, j + PREAMBLE_US * 2, aux.length)
      if (j && detectOutOfPhase(mag, j)) {
        applyPhaseCorrection(mag, j)
      }
      // TODO ... apply other kind of corrections.
    }

    // Decode all the next 112 bits, regardless of the actual message size.
    // We'll check the actual message type later.
    errors = 0
    for (i = 0; i < LONG_MSG_BITS * 2; i += 2) {
      low = mag[j + i + PREAMBLE_US * 2]
      high = mag[j + i + PREAMBLE_US * 2 + 1]
      delta = low - high
      if (delta < 0) delta = -delta

      if (i > 0 && delta < 256) {
        bits[i / 2] = bits[i / 2 - 1]
      } else if (low === high) {
        // Checking if two adiacent samples have the same magnitude is
        // an effective way to detect if it's just random noise that
        // was detected as a valid preamble.
        bits[i / 2] = 2 // error
        if (i < SHORT_MSG_BITS * 2) errors++
      } else if (low > high) {
        bits[i / 2] = 1
      } else {
        // (low < high) for exclusion
        bits[i / 2] = 0
      }
    }

    // Restore the original message if we used magnitude correction.
    if (useCorrection) {
      memcpy(mag, j + PREAMBLE_US * 2, aux, 0, aux.length)
    }

    // Pack bits into bytes
    for (i = 0; i < LONG_MSG_BITS; i += 8) {
      msg[i / 8] =
          bits[i] << 7 |
          bits[i + 1] << 6 |
          bits[i + 2] << 5 |
          bits[i + 3] << 4 |
          bits[i + 4] << 3 |
          bits[i + 5] << 2 |
          bits[i + 6] << 1 |
          bits[i + 7]
    }

    const msgtype = msg[0] >> 3
    const msglen = msgLenByType(msgtype) / 8

    // Last check, high and low bits are different enough in magnitude to
    // mark this as real message and not just noise?
    delta = 0
    for (i = 0; i < msglen * 8 * 2; i += 2) {
      delta += Math.abs(mag[j + i + PREAMBLE_US * 2] -
                        mag[j + i + PREAMBLE_US * 2 + 1])
    }
    delta /= msglen * 4

    // Filter for an average delta of three is small enough to let almost
    // every kind of message to pass, but high enough to filter some random
    // noise.
    if (delta < 10 * 255) {
      useCorrection = false
      continue
    }

    // If we reached this point, and error is zero, we are very likely with
    // a Mode S message in our hands, but it may still be broken and CRC
    // may not be correct. This is handled by the next layer.
    if (errors === 0 || (self.aggressive && errors < 3)) {
      const mm = new Message()

      // Decode the received message
      decode(self, mm, msg)

      // Skip this message if we are sure it's fine.
      if (mm.crcok) {
        j += (PREAMBLE_US + (msglen * 8)) * 2
        goodMessage = true
        if (useCorrection) mm.phaseCorrected = true
      }

      // Pass data to the next layer
      if (self.checkCrc === 0 || mm.crcok) {
        cb(self, mm)
      }
    }

    // Retry with phase correction if possible.
    if (!goodMessage && !useCorrection) {
      j--
      useCorrection = true
    } else {
      useCorrection = false
    }
  }
}
