/**
 * Validate a DSH session log the way production restore does — out-of-process.
 *
 * Usage: node scripts/check-session-log.mjs <session dir | log file> [...more]
 *
 * Per log: resolve the newest storage generation, decompress (concatenated zstd
 * frames, node:zlib zstd), decode every row through the HOST's own Session
 * format catalog (`@deepseek-ai/dsh-session-format-catalog` — the same codec and
 * migration chain the JSONL persistence backend runs), count malformed
 * tool/result messages (non-array content = the bricked-session shape), then
 * gate the artifact through `Session.fromRestore` and `deriveMessages`.
 * Exit 1 if anything fails.
 *
 * Reading the host's catalog instead of hand-decoding rows is deliberate: the
 * storage encoding is provider-owned and has changed repeatedly (`packChunkRuns`
 * / `decodeStorageRecord` were removed in the 0.1.5 line; format v4 moved
 * tool results to first-class `role: "tool"` messages whose `content` IS the
 * block array, with no `{type: "tool-result"}` wrapper). Mirroring the backend's
 * own decoder keeps this checker honest across format generations.
 *
 * Storage layout (0.1.5+): sessions/<slug>/<session-id>/session[.v<N>].jsonl[.zstd]
 * — every version carries its own immutable generation file, so a session that
 * survived upgrades accumulates them and the newest one is the current log.
 *
 * Pre-v4 logs additionally need the parent's historical children for the
 * V3→V4 migration (`createSessionFormatCatalogWithChildren`; an empty array
 * declares no children). This checker detects children from the sibling session
 * directories and passes `[]` only when there genuinely are none; a legacy log
 * WITH children is reported rather than migrated with a wrong fact set.
 *
 * Host codec resolution order: $DSH_HOST_PKGS → the shared profile fallback
 * (${DSH_HOME:-~/.dsh}/profiles/node_modules/@deepseek-ai, where a dsh install
 * links the running host's packages) → the legacy scoop install → the bare
 * specifier. Verified against dsh 0.2.0-rc.2 (dsh-session 0.2.0-rc.2, storage
 * format v4).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
let createSessionFormatCatalogWithChildren;
try {
  ({ sessionFormatCatalog, createSessionFormatCatalogWithChildren } = await importHostPackage('dsh-session-format-catalog'));
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
 * @param logPath - the session log; plaintext `.jsonl` is accepted too.
 * @returns the decoded JSONL text, the zstd frame count, and any torn-tail note.
 */
function readLogBytes(logPath) {
  const buf = readFileSync(logPath);
  // zstd frame magic: 0x28 B5 2F FD; else treat as plaintext
  if (!(buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC)) return { text: buf.toString('utf8'), frames: 0, torn: undefined };
  const { frames, torn } = scanZstdFrames(buf);
  if (frames.length === 0) throw new Error(`no complete zstd frame (${torn})`);
  const text = Buffer.concat(frames.map(({ start, end }) => zstdDecompressSync(buf.subarray(start, end)))).toString('utf8');
  return { text, frames: frames.length, torn };
}

/** Generation filename: `session.jsonl[.zstd]` (v0) or `session.v<N>.jsonl[.zstd]`. */
const GENERATION_NAME = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/;

/** Version of one generation filename; undefined when it is not a generation. */
function generationVersion(name) {
  const match = GENERATION_NAME.exec(name);
  if (match === null) return undefined;
  return match[1] === undefined ? 0 : Number(match[1]);
}

/**
 * Resolve a CLI argument to one log file: a directory selects its newest
 * generation, a file is used as given.
 * @param arg - session directory or log file path.
 * @returns the resolved log path.
 */
function resolveLogPath(arg) {
  if (!existsSync(arg)) throw new Error(`no such file or directory: ${arg}`);
  if (!statSync(arg).isDirectory()) return arg;
  const candidates = readdirSync(arg, { withFileTypes: true })
    .filter((entry) => entry.isFile() && GENERATION_NAME.test(entry.name))
    .map((entry) => ({ name: entry.name, version: generationVersion(entry.name) }))
    .sort((left, right) => right.version - left.version);
  if (candidates.length === 0) throw new Error(`no session generation file in ${arg}`);
  return join(arg, candidates[0].name);
}

/** Read only the first frame of an artifact — production stores the header alone there. */
function readStoredHeader(logPath) {
  const buf = readFileSync(logPath);
  if (!(buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC)) {
    const line = buf.toString('utf8').split('\n', 1)[0];
    return line === undefined || line === '' ? undefined : JSON.parse(line);
  }
  const end = scanFrame(buf, 0);
  const firstLine = zstdDecompressSync(buf.subarray(0, end)).toString('utf8').split('\n', 1)[0];
  return firstLine === '' ? undefined : JSON.parse(firstLine);
}

/**
 * Find the session's direct historical children: sibling session directories
 * whose stored header names this session as parent.
 * @param logPath - the resolved log file (inside its session directory).
 * @param parentId - the parent session id.
 * @returns child ids in directory order.
 */
function findHistoricalChildren(logPath, parentId) {
  const bucket = dirname(dirname(logPath));
  const children = [];
  for (const entry of readdirSync(bucket, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('session-')) continue;
    const childDir = join(bucket, entry.name);
    let childLog;
    try {
      childLog = resolveLogPath(childDir);
    } catch {
      continue;
    }
    let header;
    try {
      header = readStoredHeader(childLog);
    } catch {
      continue;
    }
    if (header?.parentSession === parentId && header?.id !== parentId) children.push(header.id);
    else if (header?.parentSession === parentId) children.push(entry.name);
  }
  return children;
}

/**
 * Select the catalog that can read this artifact: the plain current catalog for
 * current-format logs, otherwise a children-bound catalog (the V3→V4 migration
 * refuses to run without an explicit child fact set, `[]` meaning childless).
 * @param storedVersion - header version read from storage.
 * @param logPath - resolved log path.
 * @param id - session id.
 * @returns the catalog to restore with.
 */
function selectCatalog(storedVersion, logPath, id) {
  if (storedVersion === sessionFormatCatalog.currentVersion) return sessionFormatCatalog;
  const children = findHistoricalChildren(logPath, id);
  if (children.length > 0) {
    throw new Error(
      `legacy v${storedVersion} log has ${children.length} historical child session(s) [${children.join(', ')}]; `
      + 'the V3→V4 migration needs their evidence, which only the harness collects. Validate the session\'s '
      + `current generation (session.v${sessionFormatCatalog.currentVersion}.jsonl.zstd) instead, or open it in dsh.`,
    );
  }
  return createSessionFormatCatalogWithChildren([]);
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
 * @param arg - session directory or log file path.
 * @returns a per-log report for the summary line.
 */
function checkLog(arg) {
  const logPath = resolveLogPath(arg);
  const name = `${basename(dirname(logPath))}/${basename(logPath)}`;
  const { text, frames, torn } = readLogBytes(logPath);
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

  const catalog = selectCatalog(info.storedVersion, logPath, headerLine.id);
  // The exact options the JSONL backend uses to read a stored log
  // (dsh-session-persistence-jsonl parseHeaderRecord).
  const restore = catalog.createRestore(headerLine, { recovery: 'strict', validation: 'transformed' });
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

  // Current format: a tool result is a first-class `role: "tool"` message whose
  // `content` IS the ContentBlock[] (format v4 dropped the old
  // `[{type: "tool-result", content}]` wrapper). The bricked shape this checker
  // exists for — a bare string where blocks belong — fails the array check.
  let toolResults = 0;
  let malformed = 0;
  for (const event of artifact.events) {
    if (event?.type !== 'tool/result') continue;
    toolResults++;
    const content = event?.data?.message?.content;
    if (!Array.isArray(content) || content.length === 0
      || content.some((block) => block === null || typeof block !== 'object' || typeof block.type !== 'string')) malformed++;
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
    toolResults,
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
    console.log(`${verdict}  ${r.name}: id=${r.id} v=${r.storedVersion}->${sessionFormatCatalog.currentVersion} events=${r.events} toolResults=${r.toolResults} malformed=${r.malformed} fromRestore=ok messages=${r.messages} frames=${r.frames}${notes}`);
    if (r.malformed !== 0) failed++;
  } catch (error) {
    failed++;
    console.log(`FAIL  ${arg}: ${error?.message ?? String(error)}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
