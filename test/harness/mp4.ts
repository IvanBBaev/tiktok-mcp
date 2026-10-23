/**
 * ISO base-media (MP4/MOV) box builders for the media pre-flight tests
 * (`api/media.ts`). Every offset the parser reads is laid out here by hand, so
 * a test pins the parser against an independent layout rather than a recorded
 * sample that merely happens to parse.
 */

export function u32(...values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => buf.writeUInt32BE(value, i * 4));
  return buf;
}

export function u64(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(value));
  return buf;
}

export function box(type: string, ...parts: Buffer[]): Buffer {
  const payload = Buffer.concat(parts);
  return Buffer.concat([u32(payload.length + 8), Buffer.from(type, 'latin1'), payload]);
}

export function fullBox(type: string, version: number, ...parts: Buffer[]): Buffer {
  return box(type, Buffer.from([version, 0, 0, 0]), ...parts);
}

/** `mvhd`/`mdhd` with the timing fields where each version puts them. */
export function timingBox(
  type: string,
  version: 0 | 1,
  timescale: number,
  duration: number,
): Buffer {
  return version === 1
    ? fullBox(type, 1, u64(0), u64(0), u32(timescale), u64(duration), Buffer.alloc(8))
    : fullBox(type, 0, u32(0, 0, timescale, duration), Buffer.alloc(8));
}

export function tkhd(version: 0 | 1, width: number, height: number): Buffer {
  const lead = version === 1 ? 32 : 20; // times, track id, reserved, duration
  return fullBox(
    'tkhd',
    version,
    Buffer.alloc(lead + 52), // reserved, layer, group, volume, reserved, matrix
    u32(width * 65536, height * 65536),
  );
}

export function hdlr(handler: string): Buffer {
  return fullBox('hdlr', 0, u32(0), Buffer.from(handler, 'latin1'), Buffer.alloc(12));
}

export function stsd(fourcc: string | undefined): Buffer {
  return fourcc === undefined
    ? fullBox('stsd', 0, u32(0))
    : fullBox('stsd', 0, u32(1), box(fourcc, Buffer.alloc(78)));
}

export function stts(...counts: number[]): Buffer {
  return fullBox(
    'stts',
    0,
    u32(counts.length),
    ...counts.map((count) => u32(count, 1000)),
  );
}

export interface MovieOpts {
  version?: 0 | 1;
  movieScale?: number;
  movieDuration?: number;
  handler?: string;
  width?: number;
  height?: number;
  codec?: string | undefined;
  mediaScale?: number;
  mediaDuration?: number;
  samples?: number[];
  withMvhd?: boolean;
  withStts?: boolean;
  withStbl?: boolean;
}

/** A `moov` box: 10 s at 30 fps, 1080×1920 H.264 unless told otherwise. */
export function moov(opts: MovieOpts = {}): Buffer {
  const version = opts.version ?? 0;
  const stblParts = [stsd('codec' in opts ? opts.codec : 'avc1')];
  if (opts.withStts !== false) stblParts.push(stts(...(opts.samples ?? [300])));
  const mdia = box(
    'mdia',
    timingBox('mdhd', version, opts.mediaScale ?? 30_000, opts.mediaDuration ?? 300_000),
    hdlr(opts.handler ?? 'vide'),
    ...(opts.withStbl === false ? [] : [box('minf', box('stbl', ...stblParts))]),
  );
  return box(
    'moov',
    ...(opts.withMvhd === false
      ? []
      : [
          timingBox(
            'mvhd',
            version,
            opts.movieScale ?? 1000,
            opts.movieDuration ?? 10_000,
          ),
        ]),
    box('trak', tkhd(version, opts.width ?? 1080, opts.height ?? 1920), mdia),
  );
}

/** The payload of a `moov` box — what {@link inspectMovie} takes. */
export function payload(movie: Buffer): Buffer {
  return movie.subarray(8);
}

export const FTYP_MP4 = box('ftyp', Buffer.from('isom', 'latin1'), u32(512));
export const FTYP_QT = box('ftyp', Buffer.from('qt  ', 'latin1'), u32(0));
export const MDAT = box('mdat', Buffer.alloc(64, 7));

/** A whole MP4 file: `ftyp`, `mdat`, then `moov` — the non-faststart layout. */
export function mp4File(opts: MovieOpts = {}): Buffer {
  return Buffer.concat([FTYP_MP4, MDAT, moov(opts)]);
}
