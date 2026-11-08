import zlib from 'node:zlib';

/** Minimal PNG encoder + drawing helpers used to generate demo floor plans for the seed data. */

export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: [number, number, number];
}

function crc32(buf: Buffer): number {
  return zlib.crc32(buf);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function drawFloorPlan(width: number, height: number, rooms: Room[]): Buffer {
  const px = new Uint8Array(width * height * 3).fill(255);
  const set = (x: number, y: number, c: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
  };
  const rect = (x: number, y: number, w: number, h: number, c: [number, number, number]) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) set(xx, yy, c);
  };

  // light grid
  for (let x = 0; x < width; x += 40) for (let y = 0; y < height; y++) set(x, y, [238, 241, 245]);
  for (let y = 0; y < height; y += 40) for (let x = 0; x < width; x++) set(x, y, [238, 241, 245]);

  const wall: [number, number, number] = [55, 65, 81];
  const t = 6;
  for (const r of rooms) {
    if (r.fill) rect(r.x, r.y, r.w, r.h, r.fill);
    rect(r.x, r.y, r.w, t, wall);
    rect(r.x, r.y + r.h - t, r.w, t, wall);
    rect(r.x, r.y, t, r.h, wall);
    rect(r.x + r.w - t, r.y, t, r.h, wall);
    // door gap on the bottom wall
    rect(r.x + Math.floor(r.w / 2) - 25, r.y + r.h - t, 50, t, [255, 255, 255]);
  }
  // outer wall
  rect(20, 20, width - 40, 10, wall);
  rect(20, height - 30, width - 40, 10, wall);
  rect(20, 20, 10, height - 40, wall);
  rect(width - 30, 20, 10, height - 40, wall);
  return encodePng(width, height, px);
}

export const OFFICE_LAYOUT: Room[] = [
  { x: 40, y: 40, w: 360, h: 300, fill: [247, 250, 252] },
  { x: 400, y: 40, w: 360, h: 300, fill: [247, 250, 252] },
  { x: 760, y: 40, w: 360, h: 300, fill: [247, 250, 252] },
  { x: 1120, y: 40, w: 440, h: 300, fill: [240, 247, 255] },
  { x: 40, y: 560, w: 520, h: 400, fill: [247, 250, 252] },
  { x: 560, y: 560, w: 300, h: 400, fill: [255, 248, 235] },
  { x: 860, y: 560, w: 700, h: 400, fill: [247, 250, 252] },
];

export const HALL_LAYOUT: Room[] = [
  { x: 40, y: 40, w: 1520, h: 700, fill: [250, 250, 247] },
  { x: 40, y: 740, w: 380, h: 220, fill: [240, 247, 255] },
  { x: 420, y: 740, w: 380, h: 220, fill: [247, 250, 252] },
  { x: 800, y: 740, w: 760, h: 220, fill: [255, 248, 235] },
];

export const DATACENTER_LAYOUT: Room[] = [
  { x: 40, y: 40, w: 1000, h: 920, fill: [238, 246, 255] },
  { x: 1040, y: 40, w: 520, h: 450, fill: [247, 250, 252] },
  { x: 1040, y: 490, w: 520, h: 470, fill: [255, 248, 235] },
];
