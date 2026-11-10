import { CsvParserOptions } from './types';

/**
 * Normalizes input chunks into an AsyncIterable of string chunks,
 * stripping UTF-8 BOM if present at the very beginning.
 */
async function* normalizeInputToChunks(
  input: string | Buffer | NodeJS.ReadableStream | AsyncIterable<string | Buffer>
): AsyncGenerator<string> {
  let isFirstChunk = true;

  if (typeof input === 'string') {
    let text = input;
    if (text.charCodeAt(0) === 0xFEFF) {
      text = text.slice(1);
    }
    yield text;
    return;
  }

  if (Buffer.isBuffer(input)) {
    let buf = input;
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      buf = buf.subarray(3);
    }
    yield buf.toString('utf8');
    return;
  }

  // Handle stream or async iterable
  const iterable = input as AsyncIterable<string | Buffer>;
  for await (const rawChunk of iterable) {
    let chunk = typeof rawChunk === 'string' ? rawChunk : rawChunk.toString('utf8');
    if (isFirstChunk) {
      isFirstChunk = false;
      if (chunk.charCodeAt(0) === 0xFEFF) {
        chunk = chunk.slice(1);
      }
    }
    yield chunk;
  }
}

/**
 * Detects delimiter (comma ',' vs semicolon ';') from text outside of quoted regions.
 */
export function detectDelimiter(sample: string): string {
  let commaCount = 0;
  let semicolonCount = 0;
  let inQuotes = false;

  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i];
    if (ch === '"') {
      if (inQuotes && sample[i + 1] === '"') {
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes) {
      if (ch === '\n' || ch === '\r') {
        // Stop at first line if we found delimiters
        if (commaCount > 0 || semicolonCount > 0) {
          break;
        }
      } else if (ch === ',') {
        commaCount++;
      } else if (ch === ';') {
        semicolonCount++;
      }
    }
  }

  return semicolonCount > commaCount ? ';' : ',';
}

/**
 * Streaming RFC 4180 compliant CSV parser.
 * Yields rows (as string arrays) one by one without accumulating raw rows in memory.
 */
export async function* parseCsvStream(
  input: string | Buffer | NodeJS.ReadableStream | AsyncIterable<string | Buffer>,
  options?: CsvParserOptions
): AsyncGenerator<string[]> {
  const skipEmptyLines = options?.skipEmptyLines ?? true;
  let delimiter = options?.delimiter;

  // Parser state
  enum State {
    FIELD_START = 0,
    UNQUOTED = 1,
    QUOTED = 2,
    AFTER_QUOTE = 3,
  }

  let state: State = State.FIELD_START;
  let currentRow: string[] = [];
  let currentField = '';
  let pendingCR = false;

  // We buffer chunks if delimiter needs to be detected from the first line
  const chunkIterator = normalizeInputToChunks(input);
  let initialChunk: string | null = null;

  if (!delimiter) {
    const first = await chunkIterator.next();
    if (first.done || !first.value) {
      return;
    }
    initialChunk = first.value;
    delimiter = detectDelimiter(initialChunk);
  }

  async function* getChunks(): AsyncGenerator<string> {
    if (initialChunk !== null) {
      yield initialChunk;
    }
    for await (const chunk of chunkIterator) {
      yield chunk;
    }
  }

  for await (const chunk of getChunks()) {
    const len = chunk.length;
    let i = 0;

    // Handle CRLF split across chunks
    if (pendingCR) {
      pendingCR = false;
      if (chunk[0] === '\n') {
        i = 1;
      }
    }

    while (i < len) {
      const ch = chunk[i];

      switch (state) {
        case State.FIELD_START: {
          if (ch === '"') {
            state = State.QUOTED;
          } else if (ch === delimiter) {
            currentRow.push('');
            currentField = '';
          } else if (ch === '\r') {
            if (i + 1 < len) {
              if (chunk[i + 1] === '\n') {
                i++;
              }
            } else {
              pendingCR = true;
            }
            currentRow.push(currentField);
            currentField = '';
            if (!skipEmptyLines || currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
              yield currentRow;
            }
            currentRow = [];
          } else if (ch === '\n') {
            currentRow.push(currentField);
            currentField = '';
            if (!skipEmptyLines || currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
              yield currentRow;
            }
            currentRow = [];
          } else {
            currentField += ch;
            state = State.UNQUOTED;
          }
          break;
        }

        case State.UNQUOTED: {
          if (ch === delimiter) {
            currentRow.push(currentField);
            currentField = '';
            state = State.FIELD_START;
          } else if (ch === '\r') {
            if (i + 1 < len) {
              if (chunk[i + 1] === '\n') {
                i++;
              }
            } else {
              pendingCR = true;
            }
            currentRow.push(currentField);
            currentField = '';
            state = State.FIELD_START;
            if (!skipEmptyLines || currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
              yield currentRow;
            }
            currentRow = [];
          } else if (ch === '\n') {
            currentRow.push(currentField);
            currentField = '';
            state = State.FIELD_START;
            if (!skipEmptyLines || currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
              yield currentRow;
            }
            currentRow = [];
          } else {
            currentField += ch;
          }
          break;
        }

        case State.QUOTED: {
          if (ch === '"') {
            state = State.AFTER_QUOTE;
          } else {
            currentField += ch;
          }
          break;
        }

        case State.AFTER_QUOTE: {
          if (ch === '"') {
            // Escaped quote: "" inside quotes becomes "
            currentField += '"';
            state = State.QUOTED;
          } else if (ch === delimiter) {
            currentRow.push(currentField);
            currentField = '';
            state = State.FIELD_START;
          } else if (ch === '\r') {
            if (i + 1 < len) {
              if (chunk[i + 1] === '\n') {
                i++;
              }
            } else {
              pendingCR = true;
            }
            currentRow.push(currentField);
            currentField = '';
            state = State.FIELD_START;
            if (!skipEmptyLines || currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
              yield currentRow;
            }
            currentRow = [];
          } else if (ch === '\n') {
            currentRow.push(currentField);
            currentField = '';
            state = State.FIELD_START;
            if (!skipEmptyLines || currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
              yield currentRow;
            }
            currentRow = [];
          } else if (ch === ' ' || ch === '\t') {
            // RFC 4180 permits whitespace after closing quote before delimiter/newline in common usage
            // Stay in AFTER_QUOTE
          } else {
            // Non-standard trailing char: append and remain in AFTER_QUOTE or switch
            currentField += ch;
          }
          break;
        }
      }

      i++;
    }
  }

  // End of all chunks: handle remaining field / row
  if (state === State.QUOTED || state === State.AFTER_QUOTE || state === State.UNQUOTED || state === State.FIELD_START) {
    if (currentField !== '' || currentRow.length > 0) {
      currentRow.push(currentField);
      if (!skipEmptyLines || currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== '')) {
        yield currentRow;
      }
    }
  }
}
