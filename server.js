// server.js
'use strict';

const net = require('net');

const HOST = '127.0.0.1';
const PORT = 9000;

function decodeCanPayload(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 8) {
    throw new Error('payload must be Buffer(8)');
  }

  // Read 64 bits MSB-first across bytes: first bit is (buf[0] >> 7) & 1
  let bitPos = 0;
  const readBit = () => {
    const byteIndex = bitPos >> 3;
    const bitInByte = 7 - (bitPos & 7);
    const bit = (buf[byteIndex] >> bitInByte) & 1;
    bitPos++;
    return bit;
  };

  const readBits = (width) => {
    let v = 0;
    for (let i = 0; i < width; i++) v = (v << 1) | readBit();
    return v;
  };

  const header = readBits(4);
  const pwm = [];
  for (let i = 0; i < 6; i++) pwm.push(readBits(10));
  return { header, pwm };
}

function toHexDash(buf) {
  return [...buf].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('-');
}

const server = net.createServer((socket) => {
  console.log(`Client connected: ${socket.remoteAddress}:${socket.remotePort}`);
  socket.setNoDelay(true);

  let acc = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    acc = Buffer.concat([acc, chunk]);

    while (acc.length >= 8) {
      const frame = acc.subarray(0, 8);
      acc = acc.subarray(8);

      const { header, pwm } = decodeCanPayload(frame);
      const headerBits = header.toString(2).padStart(4, '0');

      console.log(`PWM: ${pwm.join(',')}`);
      console.log(`DATA: ${toHexDash(frame)}  HEADER:${headerBits}`);
      if (header !== 0b1010) console.log('WARN: bad header (expected 1010)');
    }
  });

  socket.on('close', () => console.log('Client disconnected'));
  socket.on('error', (e) => console.log(`Socket error: ${e.message}`));
});

server.listen(PORT, HOST, () => {
  console.log(`Listening on ${HOST}:${PORT}`);
});