import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  parseCsvStream,
  detectDelimiter,
  normalizeIranianMobile,
  maskPhoneNumber,
  detectColumnMapping,
  importContacts,
  RejectionReasonCode,
} from '../src/contacts-import';

describe('Contacts CSV Import Module', () => {
  describe('RFC 4180 CSV Streaming Parser (AC-01)', () => {
    it('parses standard comma-separated values with CRLF and LF', async () => {
      const csv = 'col1,col2\r\nval1,val2\nval3,val4\r\n';
      const rows: string[][] = [];
      for await (const row of parseCsvStream(csv)) {
        rows.push(row);
      }
      assert.deepEqual(rows, [
        ['col1', 'col2'],
        ['val1', 'val2'],
        ['val3', 'val4'],
      ]);
    });

    it('handles quoted fields with commas and newlines inside quotes', async () => {
      const csv = '"name","notes"\r\n"Ali","tehran, iran"\r\n"Reza","line 1\nline 2"\r\n';
      const rows: string[][] = [];
      for await (const row of parseCsvStream(csv)) {
        rows.push(row);
      }
      assert.deepEqual(rows, [
        ['name', 'notes'],
        ['Ali', 'tehran, iran'],
        ['Reza', 'line 1\nline 2'],
      ]);
    });

    it('handles escaped quotes inside quoted fields ("")', async () => {
      const csv = '"col1","col2"\r\n"he said ""hello""","normal"\r\n';
      const rows: string[][] = [];
      for await (const row of parseCsvStream(csv)) {
        rows.push(row);
      }
      assert.deepEqual(rows, [
        ['col1', 'col2'],
        ['he said "hello"', 'normal'],
      ]);
    });

    it('strips UTF-8 BOM transparently', async () => {
      const bomBuffer = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('phone,name\r\n09120000001,User1\r\n'),
      ]);
      const rows: string[][] = [];
      for await (const row of parseCsvStream(bomBuffer)) {
        rows.push(row);
      }
      assert.deepEqual(rows, [
        ['phone', 'name'],
        ['09120000001', 'User1'],
      ]);
    });

    it('supports semicolon delimiter and auto-detects delimiter', async () => {
      const semicolonCsv = 'phone;name;city\r\n09120000001;User1;Tehran\r\n09120000002;User2;Isfahan';
      assert.equal(detectDelimiter(semicolonCsv), ';');

      const rows: string[][] = [];
      for await (const row of parseCsvStream(semicolonCsv)) {
        rows.push(row);
      }
      assert.deepEqual(rows, [
        ['phone', 'name', 'city'],
        ['09120000001', 'User1', 'Tehran'],
        ['09120000002', 'User2', 'Isfahan'],
      ]);
    });

    it('parses chunked stream where chunks split fields, quotes and CRLF', async () => {
      async function* chunkGenerator() {
        yield 'phone,"na';
        yield 'me",cit';
        yield 'y\r';
        yield '\n09120000001,"User, ';
        yield 'One",Tehran\r\n';
      }
      const rows: string[][] = [];
      for await (const row of parseCsvStream(chunkGenerator())) {
        rows.push(row);
      }
      assert.deepEqual(rows, [
        ['phone', 'name', 'city'],
        ['09120000001', 'User, One', 'Tehran'],
      ]);
    });

    it('skips empty lines properly', async () => {
      const csv = 'phone\r\n\r\n09120000001\r\n\r\n\r\n09120000002\r\n\r\n';
      const rows: string[][] = [];
      for await (const row of parseCsvStream(csv)) {
        rows.push(row);
      }
      assert.deepEqual(rows, [
        ['phone'],
        ['09120000001'],
        ['09120000002'],
      ]);
    });
  });

  describe('Column and Header Detection (AC-02)', () => {
    it('detects common English headers (phone, mobile, name, first_name, last_name)', () => {
      const row = ['first_name', 'last_name', 'mobile', 'email'];
      const mapping = detectColumnMapping(row);
      assert.equal(mapping.isHeaderRow, true);
      assert.equal(mapping.phoneIndex, 2);
      assert.equal(mapping.firstNameIndex, 0);
      assert.equal(mapping.lastNameIndex, 1);
    });

    it('detects common Persian headers (موبایل، نام، نام خانوادگی)', () => {
      const row = ['نام', 'نام خانوادگی', 'موبایل'];
      const mapping = detectColumnMapping(row);
      assert.equal(mapping.isHeaderRow, true);
      assert.equal(mapping.phoneIndex, 2);
      assert.equal(mapping.firstNameIndex, 0);
      assert.equal(mapping.lastNameIndex, 1);
    });

    it('detects single Persian phone header (شماره تماس)', () => {
      const row = ['شماره تماس'];
      const mapping = detectColumnMapping(row);
      assert.equal(mapping.isHeaderRow, true);
      assert.equal(mapping.phoneIndex, 0);
    });

    it('detects file without header where first row is a phone number', () => {
      const row = ['09120000001', 'User Alpha'];
      const mapping = detectColumnMapping(row);
      assert.equal(mapping.isHeaderRow, false);
      assert.equal(mapping.phoneIndex, 0);
    });

    it('accepts single-column file with only phone numbers and no header', async () => {
      const csv = '09120000001\r\n09120000002\r\n09120000003';
      const result = await importContacts(csv);
      assert.equal(result.summary.totalRows, 3);
      assert.equal(result.summary.validCount, 3);
      assert.equal(result.validRows.length, 3);
      assert.equal(result.validRows[0].normalizedPhone, '+989120000001');
      assert.equal(result.validRows[1].normalizedPhone, '+989120000002');
      assert.equal(result.validRows[2].normalizedPhone, '+989120000003');
    });

    it('preserves optional name columns and extra attributes', async () => {
      const csv = 'تلفن,نام,شهر\r\n09120000001,کاربر نمونه,تهران\r\n';
      const result = await importContacts(csv);
      assert.equal(result.summary.validCount, 1);
      assert.equal(result.validRows[0].normalizedPhone, '+989120000001');
      assert.equal(result.validRows[0].name, 'کاربر نمونه');
      assert.deepEqual(result.validRows[0].attributes, { 'شهر': 'تهران' });
    });
  });

  describe('Iranian Mobile Number Normalization (AC-03)', () => {
    const positiveCases = [
      { input: '09120000001', expected: '+989120000001', desc: 'standard 09...' },
      { input: '9120000001', expected: '+989120000001', desc: '10 digits 9...' },
      { input: '989120000001', expected: '+989120000001', desc: '12 digits 989...' },
      { input: '+989120000001', expected: '+989120000001', desc: 'canonical +989...' },
      { input: '00989120000001', expected: '+989120000001', desc: 'international 00989...' },
      { input: '۰۹۱۲۰۰۰۰۰۰۱', expected: '+989120000001', desc: 'Persian digits' },
      { input: '٠٩١٢٠٠٠٠٠٠١', expected: '+989120000001', desc: 'Arabic digits' },
      { input: '0912-000-0001', expected: '+989120000001', desc: 'with hyphens' },
      { input: '(0912) 000 0001', expected: '+989120000001', desc: 'with parens and spaces' },
      { input: '+98 (912) 000-0001', expected: '+989120000001', desc: 'formatted +98' },
      { input: ' ۰۹۱۲-۰۰۰-۰۰۰۱ ', expected: '+989120000001', desc: 'Persian digits with formatting' },
      { input: '09350000002', expected: '+989350000002', desc: 'MTN Irancell 0935' },
      { input: '09200000003', expected: '+989200000003', desc: 'Rightel 0920' },
      { input: '09900000004', expected: '+989900000004', desc: 'MCI 0990' },
    ];

    for (const testCase of positiveCases) {
      it(`normalizes positive case: ${testCase.desc} ("${testCase.input}")`, () => {
        const result = normalizeIranianMobile(testCase.input);
        assert.equal(result.success, true);
        if (result.success) {
          assert.equal(result.normalized, testCase.expected);
        }
      });
    }

    const negativeCases = [
      { input: '', expectedReason: RejectionReasonCode.EMPTY_PHONE, desc: 'empty string' },
      { input: '   ', expectedReason: RejectionReasonCode.EMPTY_PHONE, desc: 'whitespace only' },
      { input: '0912abc0001', expectedReason: RejectionReasonCode.INVALID_CHARACTERS, desc: 'contains letters' },
      { input: '091200000', expectedReason: RejectionReasonCode.INVALID_LENGTH, desc: 'too short (9 digits)' },
      { input: '091200000000', expectedReason: RejectionReasonCode.INVALID_LENGTH, desc: 'too long (12 digits)' },
      { input: '02188776655', expectedReason: RejectionReasonCode.NOT_IRANIAN_MOBILE, desc: 'Tehran landline 021' },
      { input: '+982188776655', expectedReason: RejectionReasonCode.NOT_IRANIAN_MOBILE, desc: 'Landline with +9821' },
      { input: '00982188776655', expectedReason: RejectionReasonCode.NOT_IRANIAN_MOBILE, desc: 'Landline with 009821' },
      { input: '+14155552671', expectedReason: RejectionReasonCode.NOT_IRANIAN_MOBILE, desc: 'US phone number' },
      { input: '0014155552671', expectedReason: RejectionReasonCode.NOT_IRANIAN_MOBILE, desc: 'US number with 001' },
      { input: '1234567890', expectedReason: RejectionReasonCode.NOT_IRANIAN_MOBILE, desc: 'Arbitrary digits not starting with 9' },
      { input: '+9891200', expectedReason: RejectionReasonCode.INVALID_LENGTH, desc: '+989 too short' },
    ];

    for (const testCase of negativeCases) {
      it(`rejects negative case with exact reason: ${testCase.desc}`, () => {
        const result = normalizeIranianMobile(testCase.input);
        assert.equal(result.success, false);
        if (!result.success) {
          assert.equal(result.reasonCode, testCase.expectedReason);
        }
      });
    }
  });

  describe('Deduplication, Row Summary and Parametric Max Rows (AC-04)', () => {
    it('deduplicates by normalized phone keeping first occurrence', async () => {
      const csv = [
        'شماره,نام',
        '09120000001,کاربر اول',
        '9120000001,کاربر اول تکراری',
        '+989120000001,کاربر اول با مثبت',
        '09120000002,کاربر دوم',
      ].join('\r\n');

      const result = await importContacts(csv);

      assert.equal(result.summary.totalRows, 4);
      assert.equal(result.summary.validCount, 2);
      assert.equal(result.summary.duplicateCount, 2);
      assert.equal(result.summary.invalidCount, 0);

      assert.equal(result.validRows.length, 2);
      assert.equal(result.validRows[0].normalizedPhone, '+989120000001');
      assert.equal(result.validRows[0].name, 'کاربر اول');
      assert.equal(result.validRows[1].normalizedPhone, '+989120000002');
      assert.equal(result.validRows[1].name, 'کاربر دوم');

      assert.equal(result.rejectedRows.length, 2);
      assert.equal(result.rejectedRows[0].rowNumber, 3);
      assert.equal(result.rejectedRows[0].reasonCode, RejectionReasonCode.DUPLICATE_PHONE);
      assert.equal(result.rejectedRows[1].rowNumber, 4);
      assert.equal(result.rejectedRows[1].reasonCode, RejectionReasonCode.DUPLICATE_PHONE);
    });

    it('enforces totalRows === validCount + duplicateCount + invalidCount invariant', async () => {
      const csv = [
        'phone,name',
        '09120000001,Valid 1',
        '09120000001,Duplicate 1',
        '02188776655,Invalid Landline',
        '0912abc,Invalid Chars',
        '09120000002,Valid 2',
      ].join('\r\n');

      const result = await importContacts(csv);

      assert.equal(result.summary.validCount, 2);
      assert.equal(result.summary.duplicateCount, 1);
      assert.equal(result.summary.invalidCount, 2);
      assert.equal(
        result.summary.totalRows,
        result.summary.validCount + result.summary.duplicateCount + result.summary.invalidCount
      );
      assert.equal(result.summary.totalRows, 5);
    });

    it('respects parametric maxRows input option', async () => {
      const rows = ['phone'];
      for (let i = 1; i <= 10; i++) {
        rows.push(`091200000${String(i).padStart(2, '0')}`);
      }
      const csv = rows.join('\r\n');

      // maxRows = 5
      const result = await importContacts(csv, { maxRows: 5 });
      assert.equal(result.summary.validCount, 5);
      assert.equal(result.rejectedRows.length, 5);
      for (const rej of result.rejectedRows) {
        assert.equal(rej.reasonCode, RejectionReasonCode.MAX_ROWS_EXCEEDED);
      }
    });

    it('stops stream cleanly when stopOnMaxRows is set', async () => {
      const rows = ['phone'];
      for (let i = 1; i <= 20; i++) {
        rows.push(`091200000${String(i).padStart(2, '0')}`);
      }
      const csv = rows.join('\r\n');

      const result = await importContacts(csv, { maxRows: 7, stopOnMaxRows: true });
      assert.equal(result.summary.totalRows, 7);
      assert.equal(result.summary.validCount, 7);
      assert.equal(result.rejectedRows.length, 0);
    });
  });

  describe('Privacy & Masking (AC-05)', () => {
    it('masks phone numbers and never exposes full phone number in error messages or logs', async () => {
      const sensitiveSynthetic = '09129998877';
      const csv = `phone,name\r\n${sensitiveSynthetic},User Test\r\n${sensitiveSynthetic},Duplicate User\r\n02199998888,Landline User\r\n`;

      const result = await importContacts(csv);

      // Verify masking function
      const masked = maskPhoneNumber(sensitiveSynthetic);
      assert.equal(masked.includes(sensitiveSynthetic), false);
      assert.equal(masked.includes('***'), true);

      // Check duplicate rejection message
      assert.equal(result.rejectedRows.length, 2);
      const dupRejection = result.rejectedRows[0];
      assert.equal(dupRejection.message.includes(sensitiveSynthetic), false);
      assert.equal(dupRejection.message.includes('***'), true);

      // Check invalid rejection message
      const landlineRejection = result.rejectedRows[1];
      assert.equal(landlineRejection.message.includes('02199998888'), false);
      assert.equal(landlineRejection.message.includes('***'), true);
    });
  });
});
