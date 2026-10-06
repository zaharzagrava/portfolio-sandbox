/** MurmurHash3 x86 32-bit: fast, well-distributed, and the same function every SDK (backend, mobile, edge) can implement identically. */
export function murmur3(key: string, seed = 0): number {
  const data = Buffer.from(key, 'utf8');
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = seed >>> 0;
  const blocks = data.length >> 2;
  for (let i = 0; i < blocks; i++) {
    let k = data.readUInt32LE(i * 4);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }
  let k = 0;
  const tail = blocks * 4;
  switch (data.length & 3) {
    case 3:
      k ^= data[tail + 2] << 16;
    // falls through
    case 2:
      k ^= data[tail + 1] << 8;
    // falls through
    case 1:
      k ^= data[tail];
      k = Math.imul(k, c1);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, c2);
      h ^= k;
  }
  h ^= data.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
