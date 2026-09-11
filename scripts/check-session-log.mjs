/**
 * Validate a DSH session log the way production restore does — out-of-process.
 *
 * Usage: node scripts/check-session-log.mjs <path/to/session.jsonl.zstd> [...more]
 *
 * Per log: decompress (concatenated zstd frames, node:zlib zstd), parse the
 * header line, decode every event row through the HOST's own Session format
 * catalog (`@deepseek-ai/dsh-session-format-catalog` — the same codec plus
 * adjacent migration chain the JSONL persistence backend runs), count
 * malformed tool/result blocks (string content = the bricked-session shape),
 * then gate the artifact through `Session.fromRestore` and `deriveMessages`.
 * Exit 1 if anything fails.
 *
 * Reading the host's catalog instead of hand-decoding rows is deliberate: the
 * storage row encoding is provider-owned and has already changed once
 * (`packChunkRuns`/`decodeStorageRecord` were removed from dsh-session in the
 * 0.1.5 line, and every event now occupies one row). Mirroring the backend's
 * own decoder keeps this checker honest across format generations: current v3
 * logs are validated as-is and older generations go through the same
 * migrations the harness would run.
 *
 * Host codec resolution order: $DSH_HOST_PKGS → the shared profile fallback
 * (${DSH_HOME:-~/.dsh}/profiles/node_modules/@deepseek-ai, where a dsh install
 * links the running host's packages) → the legacy scoop install → the bare
 * specifier. Verified against dsh 0.1.5-rc.1 (dsh-session 0.1.5-rc.2, format
 * v3 with the catalog present).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const HOST_PKG_CANDIDATES = [
  process.env.DSH_HOST_PKGS,
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'node_modules', '@deepseek-ai'),
  'C:/Users/alygu/scoop/persist/nodejs-lts/bin/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
].filter(Boolean);

async function importHostPackage(pkg) {
  for (const base of HOST_PKG_CANDIDATES) {
    const entry = join(base, pkg, 'lib/index.js');
    if (existsSync(entry)) return import(pathToFileURL(entry).href);
  }
  return import(pkg);
}

const { Session } = await importHostPackage('dsh-session');
let sessionFormatCatalog;
try {
  ({ sessionFormatCatalog } = await importHostPackage('dsh-session-format-catalog'));
} catch (error) {
  throw new Error(
    'this checker needs the host Session format catalog (dsh 0.1.5+): set DSH_HOST_PKGS to the running host\'s '
    + 'node_modules/@deepseek-ai directory, or install the host packages here. '
    + `Underlying failure: ${error?.message ?? String(error)}`,
  );
}

// ---------------------------------------------------------------------------
// The production container is CONCATENATED independently-checksummed zstd
// frames (one per flush batch; header frame first). A whole-buffer decode
// yields only the first frame, so mirror the backend's structural frame scan
// (dsh-session-persistence-jsonl scanZstdFrames) and decode frame by frame.
// A torn final frame is REPORTED, not fatal: a live or crash-interrupted
// session legitimately ends mid-frame, and the backend restores the committed
// prefix of exactly those bytes.
// ---------------------------------------------------------------------------
const ZSTD_MAGIC = 4247762216;

/** Parse one zstd frame starting at `start`; returns its end offset or throws. */
function scanFrame(buffer, start) {
  let offset = start;
  if (buffer.length - offset < 4) throw new Error('torn frame header');
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
  if (buffer.length - offset < (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes) throw new Error('torn frame header');
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
  return offset;
}

/**
 * Scan every complete frame; a trailing partial frame stops the scan and is
 * reported (with the reason and the byte offset where decoding stopped).
 * @param buffer - the raw compressed artifact.
 * @returns complete frames plus the torn-tail diagnostic.
 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  let torn;
  while (offset < buffer.length) {
    const start = offset;
    let end;
    try {
      end = scanFrame(buffer, start);
    } catch (error) {
      torn = `${error.message} (stopped at byte ${start} of ${buffer.length})`;
      break;
    }
    frames.push({ start, end });
    offset = end;
  }
  return { frames, torn };
}

/**
 * Decode one artifact to text.
 * @param zstPath - the session log; plaintext `.jsonl` is accepted too.
 * @returns the decoded JSONL text, the zstd frame count, and any torn-tail note.
 */
function readLogBytes(zstPath) {
  const buf = readFileSync(zstPath);
  // zstd frame magic: 0x28 B5 2F FD; else treat as plaintext
  if (!(buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC)) return { text: buf.toString('utf8'), frames: 0, torn: undefined };
  const { frames, torn } = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error(`no complete zstd frame (${torn})`);
  const text = Buffer.concat(frames.map(({ start, end }) => zstdDecompressSync(buf.subarray(start, end)))).toString('utf8');
  return { text, frames: frames.length, torn };
}

/** Split decoded JSONL into the header record plus the complete event rows. */
function splitRecords(text) {
  const parts = text.split('\n');
  const trailing = parts.pop();
  // A final record without its newline was never committed whole: production's
  // scanner drops it (truncation repair rewrites it on the next append).
  const tornTail = trailing !== '';
  if (tornTail) parts.push(trailing);
  const records = parts.filter((line) => line !== '');
  return {
    header: records[0],
    rows: tornTail ? records.slice(1, -1) : records.slice(1),
    tornTail,
  };
}

/**
 * Validate one log end to end through the host's restore path.
 * @param zstPath - the session log path.
 * @returns a per-log report for the summary line.
 */
function checkLog(zstPath) {
  const name = zstPath.split(/[\\/]/).slice(-2).join('/');
  const { text, frames, torn } = readLogBytes(zstPath);
  const { header: headerRecord, rows, tornTail } = splitRecords(text);
  if (headerRecord === undefined) throw new Error('empty session log');

  let headerLine;
  try {
    headerLine = JSON.parse(headerRecord);
  } catch {
    throw new Error('first line is not valid JSON');
  }
  if (headerLine?.type !== 'session') throw new Error('first line is not the session header');

  const info = sessionFormatCatalog.readHeader(headerLine);
  if (info.status === 'unsupported') throw new Error(`unsupported session format v${info.storedVersion}: ${info.reason}`);
  if (info.status === 'malformed') throw new Error(`malformed session header: ${info.reason}`);

  // The exact options the JSONL backend uses to read a stored log
  // (dsh-session-persistence-jsonl parseHeaderRecord).
  const restore = sessionFormatCatalog.createRestore(headerLine, { recovery: 'strict', validation: 'transformed' });
  for (const [index, line] of rows.entries()) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`event row ${index + 1} is not valid JSON`);
    }
    try {
      restore.decodeRow(row);
    } catch (error) {
      throw new Error(`event row ${index + 1}: ${error?.message ?? String(error)}`);
    }
  }
  const artifact = (() => {
    try {
      return restore.finish();
    } catch (error) {
      const detail = error?.message ?? String(error);
      // Migration stages settle at EOF, so an unreadable legacy log surfaces here
      // (e.g. an event payload this build's codec does not admit).
      throw new Error(info.storedVersion === sessionFormatCatalog.currentVersion
        ? detail
        : `v${info.storedVersion} -> v${sessionFormatCatalog.currentVersion} migration: ${detail}`);
    }
  })();

  let malformed = 0;
  for (const event of artifact.events) {
    if (event?.type !== 'tool/result') continue;
    const content = event?.data?.message?.content;
    const block = Array.isArray(content) ? content[0] : undefined;
    if (!Array.isArray(content) || block?.type !== 'tool-result' || !Array.isArray(block?.content)) malformed++;
  }

  const session = Session.fromRestore(artifact.header.id, artifact.events, artifact.header, artifact.inheritedEventCount, 'detached');
  const messages = session.deriveMessages().length;

  const notes = [];
  if (tornTail) notes.push('tail=unterminated-record');
  if (torn !== undefined) notes.push(`tail=${torn}`);
  return {
    name,
    id: artifact.header.id,
    storedVersion: info.storedVersion,
    events: artifact.events.length,
    malformed,
    messages,
    frames,
    notes,
  };
}

let failed = 0;
for (const arg of process.argv.slice(2)) {
  try {
    const r = checkLog(arg);
    const verdict = r.malformed === 0 ? 'PASS' : 'FAIL';
    const notes = r.notes.length > 0 ? ` [${r.notes.join('; ')}]` : '';
    console.log(`${verdict}  ${r.name}: id=${r.id} v=${r.storedVersion}->${sessionFormatCatalog.currentVersion} events=${r.events} malformed=${r.malformed} fromRestore=ok messages=${r.messages} frames=${r.frames}${notes}`);
    if (r.malformed !== 0) failed++;
  } catch (error) {
    failed++;
    console.log(`FAIL  ${arg}: ${error?.message ?? String(error)}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
