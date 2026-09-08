/**
 * Validate a DSH session log the way production restore does — out-of-process.
 *
 * Usage: node scripts/check-session-log.mjs <path/to/session.jsonl.zstd> [...more]
 *
 * Per log: decompress (node:zlib zstd, same encoding as the host backend),
 * parse the header line, expand storage rows (decodeStorageRecord), count
 * malformed tool/result blocks (string content = the bricked-session shape),
 * then run the host `Session.fromRestore` gate. Exit 1 if anything fails.
 *
 * Host codec resolution order: $DSH_HOST_PKGS → the scoop dsh install → this
 * repo's .pnpm store (keep the resolved dsh-session on the same version as the
 * running host; verified against 0.1.2-rc.1).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const HOST_PKG_CANDIDATES = [
  process.env.DSH_HOST_PKGS,
  'C:/Users/alygu/scoop/persist/nodejs-lts/bin/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
].filter(Boolean);

async function importHostPackage(pkg) {
  for (const base of HOST_PKG_CANDIDATES) {
    const entry = join(base, pkg, 'lib/index.js');
    if (existsSync(entry)) return import(pathToFileURL(entry).href);
  }
  return import(pkg);
}

const { decodeStorageRecord, Session } = await importHostPackage('dsh-session');

// ---------------------------------------------------------------------------
// The production container is CONCATENATED independently-checksummed zstd
// frames (one per flush batch; header frame first). A whole-buffer decode
// yields only the first frame, so mirror the backend's structural frame scan
// (dsh-session-persistence-jsonl scanZstdFrames) and decode frame by frame.
// ---------------------------------------------------------------------------
const ZSTD_MAGIC = 4247762216;

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) throw new Error(`torn frame header at byte ${start}`);
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`torn block header at byte ${offset}`);
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) throw new Error(`torn block payload at byte ${offset}`);
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) throw new Error(`torn frame checksum at byte ${offset}`);
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

function readLogBytes(zstPath) {
  const buf = readFileSync(zstPath);
  // zstd frame magic: 0x28 B5 2F FD; else treat as plaintext
  if (!(buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd)) return buf;
  const frames = scanZstdFrames(buf);
  const parts = frames.map(({ start, end }) => zstdDecompressSync(buf.subarray(start, end)));
  return Buffer.concat(parts);
}

async function checkLog(zstPath) {
  const name = zstPath.split(/[\\/]/).slice(-2).join('/');
  const jsonl = readLogBytes(zstPath).toString('utf8');
  const lines = jsonl.split('\n').filter((l) => l !== '');
  const headerRaw = JSON.parse(lines[0]);
  if (headerRaw.type !== 'session') throw new Error('first line is not the session header');
  const { type: _type, ...header } = headerRaw;
  // 0.1.2+: isSeeded is mandatory and the backend synthesizes it from seedLength
  // (fromHeaderLine: `isSeeded: line.seedLength !== void 0`); seeded logs restore
  // with their fork-inherited prefix length as fromRestore's 4th argument.
  header.isSeeded ??= header.seedLength !== undefined;
  const inherited = header.isSeeded ? header.seedLength : undefined;
  const events = lines.slice(1).flatMap((line) => decodeStorageRecord(JSON.parse(line)));
  events.forEach((e, i) => { if (e.seq !== i) throw new Error(`seq gap at index ${i}: seq ${e.seq}`); });

  let malformed = 0;
  for (const e of events) {
    if (e?.type !== 'tool/result') continue;
    const block = e?.data?.message?.content?.[0];
    if (!Array.isArray(e?.data?.message?.content) || block?.type !== 'tool-result' || !Array.isArray(block?.content)) malformed++;
  }
  Session.fromRestore(header.id, events, header, inherited); // the exact production restore gate
  return { name, id: header.id, events: events.length, malformed };
}

let failed = 0;
for (const arg of process.argv.slice(2)) {
  try {
    const r = await checkLog(arg);
    const verdict = r.malformed === 0 ? 'PASS' : 'FAIL';
    console.log(`${verdict}  ${r.name}: id=${r.id} events=${r.events} malformed=${r.malformed} fromRestore=ok`);
    if (r.malformed !== 0) failed++;
  } catch (error) {
    failed++;
    console.log(`FAIL  ${arg}: ${error.message}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
