// client.js
'use strict';

const net = require('net');

const HOST = '127.0.0.1';
const PORT = 9000;
const FRAME_MS = 20;

function encodeCanPayload(pwm) {
  if (!Array.isArray(pwm) || pwm.length !== 6) {
    throw new Error('pwm must be array length 6');
  }
  for (let i = 0; i < 6; i++) {
    const v = pwm[i];
    if (!Number.isInteger(v) || v < 0 || v > 1000) {
      throw new Error(`pwm[${i}] out of range (0..1000): ${v}`);
    }
  }

  const out = Buffer.alloc(8, 0);
  let bitPos = 0; // 0..63, MSB-first across bytes

  const writeBit = (bit) => {
    const byteIndex = bitPos >> 3;
    const bitInByte = 7 - (bitPos & 7);
    if (bit) out[byteIndex] |= (1 << bitInByte);
    bitPos++;
  };

  const writeBits = (value, width) => {
    for (let b = width - 1; b >= 0; b--) writeBit((value >> b) & 1);
  };

  // Header: 1010
  writeBit(1); writeBit(0); writeBit(1); writeBit(0);

  // Channels 1 -> 6, each 10 bits MSB-first
  for (let i = 0; i < 6; i++) writeBits(pwm[i], 10);

  if (bitPos !== 64) throw new Error(`internal packing error: wrote ${bitPos} bits`);
  return out;
}

function toHexDash(buf) {
  return [...buf].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('-');
}

const pwm = Array(6).fill(500);

// Optional variation: every second change channel 1: 500 -> 700 -> 300
const variationValues = [500, 700, 300];
let variationIndex = 0;
let nextVariationAt = Date.now() + 1000;

const socket = net.createConnection({ host: HOST, port: PORT }, () => {
  console.log(`Connected to ${HOST}:${PORT}`);
  socket.setNoDelay(true);
});

socket.on('error', (e) => console.log(`Socket error: ${e.message}`));
socket.on('close', () => console.log('Disconnected'));

setInterval(() => {
  if (Date.now() >= nextVariationAt) {
    variationIndex = (variationIndex + 1) % variationValues.length;
    pwm[0] = variationValues[variationIndex];
    nextVariationAt = Date.now() + 1000;
  }

  const data = encodeCanPayload(pwm);
  socket.write(data);

  console.log(`PWM: ${pwm.join(',')}`);
  console.log(`DATA: ${toHexDash(data)}`);
}, FRAME_MS);