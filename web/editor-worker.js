importScripts("/lame.min.js");

function toInt16(value) {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? (clamped * 32768) | 0 : (clamped * 32767) | 0;
}

self.onmessage = (event) => {
  try {
    const { channels, sampleRate, kbps } = event.data;
    const stereo = channels.length > 1;
    const encoder = new lamejs.Mp3Encoder(stereo ? 2 : 1, sampleRate, kbps);
    const blockSize = 1152;
    const total = channels[0].length;
    const left = new Int16Array(blockSize);
    const right = stereo ? new Int16Array(blockSize) : null;
    const chunks = [];

    for (let offset = 0; offset < total; offset += blockSize) {
      const count = Math.min(blockSize, total - offset);
      for (let i = 0; i < count; i++) {
        left[i] = toInt16(channels[0][offset + i]);
        if (stereo) right[i] = toInt16(channels[1][offset + i]);
      }
      const leftBlock = count === blockSize ? left : left.subarray(0, count);
      const encoded = stereo
        ? encoder.encodeBuffer(leftBlock, count === blockSize ? right : right.subarray(0, count))
        : encoder.encodeBuffer(leftBlock);
      if (encoded.length) chunks.push(new Uint8Array(encoded));
      if ((offset / blockSize) % 400 === 0) {
        self.postMessage({ type: "progress", value: offset / total });
      }
    }

    const tail = encoder.flush();
    if (tail.length) chunks.push(new Uint8Array(tail));
    self.postMessage({ type: "done", chunks }, chunks.map((chunk) => chunk.buffer));
  } catch (error) {
    self.postMessage({ type: "error", message: String(error && error.message || error) });
  }
};
