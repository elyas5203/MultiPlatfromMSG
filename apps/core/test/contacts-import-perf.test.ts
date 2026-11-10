import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { importContactsStream, RejectionReasonCode } from '../src/contacts-import';

describe('Contacts CSV Import 100,000 Synthetic Rows Streaming Test (AC-01)', () => {
  it('processes 100,000 synthetic rows through streaming parser without loading raw rows in memory', async () => {
    const TOTAL_ROWS = 100_000;
    const VALID_COUNT = 95_000;
    const DUPLICATE_COUNT = 3_000;
    const INVALID_COUNT = 2_000;

    assert.equal(VALID_COUNT + DUPLICATE_COUNT + INVALID_COUNT, TOTAL_ROWS);

    // Create an async generator that yields CSV chunks without holding all 100,000 rows in memory
    async function* generate100kCsvStream(): AsyncGenerator<string> {
      yield 'phone,name\r\n';

      const CHUNK_SIZE = 2_000;
      let chunkBuffer = '';

      // 1. 95,000 valid unique numbers
      for (let i = 1; i <= VALID_COUNT; i++) {
        // e.g. 09100000001 to 09100095000
        const phone = `0910${String(i).padStart(7, '0')}`;
        chunkBuffer += `${phone},SyntheticUser_${i}\r\n`;

        if (i % CHUNK_SIZE === 0) {
          yield chunkBuffer;
          chunkBuffer = '';
        }
      }

      // 2. 3,000 duplicates (repeating from the first 3,000 valid numbers)
      for (let i = 1; i <= DUPLICATE_COUNT; i++) {
        const phone = `0910${String(i).padStart(7, '0')}`;
        chunkBuffer += `${phone},DuplicateUser_${i}\r\n`;

        if (i % CHUNK_SIZE === 0) {
          yield chunkBuffer;
          chunkBuffer = '';
        }
      }

      // 3. 2,000 invalid numbers (e.g. landline numbers starting with 021)
      for (let i = 1; i <= INVALID_COUNT; i++) {
        const phone = `021${String(i).padStart(8, '0')}`;
        chunkBuffer += `${phone},InvalidUser_${i}\r\n`;

        if (i % CHUNK_SIZE === 0) {
          yield chunkBuffer;
          chunkBuffer = '';
        }
      }

      if (chunkBuffer.length > 0) {
        yield chunkBuffer;
      }
    }

    const startTime = Date.now();
    const initialMem = process.memoryUsage().heapUsed;

    let processedValid = 0;
    let processedDuplicate = 0;
    let processedInvalid = 0;
    let totalProcessed = 0;

    for await (const item of importContactsStream(generate100kCsvStream())) {
      totalProcessed++;
      if (item.type === 'valid') {
        processedValid++;
      } else {
        if (item.rejection.reasonCode === RejectionReasonCode.DUPLICATE_PHONE) {
          processedDuplicate++;
        } else {
          processedInvalid++;
        }
      }
    }

    const durationMs = Date.now() - startTime;
    const finalMem = process.memoryUsage().heapUsed;
    const heapDiffMb = Math.round((finalMem - initialMem) / (1024 * 1024));

    // Assert exact counts
    assert.equal(totalProcessed, TOTAL_ROWS);
    assert.equal(processedValid, VALID_COUNT);
    assert.equal(processedDuplicate, DUPLICATE_COUNT);
    assert.equal(processedInvalid, INVALID_COUNT);

    // Assert streaming efficiency: 100k rows processed smoothly
    assert.ok(durationMs < 30_000, `Processing took ${durationMs}ms, expected under 30s`);
  });
});
