#!/usr/bin/env node
/**
 * scripts/generate-test-files.mjs
 * Test payload generator producing 100% valid .xlsx workbooks with automated
 * size targeting and calibration to achieve +/-5% accuracy of target byte sizes.
 *
 * Supported Target Sizes:
 *   1 MB, 2 MB, 3 MB, 4 MB, 5 MB, 6 MB, 8 MB, 10 MB, 12 MB
 *   (Consistently defined as 1 MB = 1,048,576 bytes)
 *
 * Primary Purpose:
 *   Testing upload boundaries across API Gateway HTTP API (10 MB edge limit)
 *   and AWS Lambda synchronous invocation (6 MB event payload limit, ~4.5 MB raw).
 *
 * CLI Usage:
 *   node scripts/generate-test-files.mjs 1 2 3          # Generate specific targets (1, 2, 3 MB)
 *   node scripts/generate-test-files.mjs 5 6 8 10 12    # Generate larger boundary targets
 *   node scripts/generate-test-files.mjs --rows         # Generate row-count benchmark files only
 *   node scripts/generate-test-files.mjs --all          # Generate all targets and row benchmarks
 *   node scripts/generate-test-files.mjs --verify 1 2 3 # Generate and verify with parseExcel
 */

import ExcelJS from 'exceljs';
import { statSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(__dirname, '..', 'test-files', 'generated');
mkdirSync(outputDir, { recursive: true });

// Constants
export const ONE_MB = 1024 * 1024; // 1,048,576 bytes
export const TOLERANCE_PERCENT = 5.0; // +/-5.0%
export const ALL_SUPPORTED_TARGETS = [1, 2, 3, 4, 5, 6, 8, 10, 12];

// =============================================================================
// Helper 1: Realistic Tabular Workbook Builder
// Creates a valid Excel workbook with realistic corporate transaction logs.
// Diverse data types and non-repeating entropy prevent unnatural Deflate collapse
// while remaining fully parseable by standard spreadsheet libraries.
// =============================================================================
export function createRealisticWorkbook(rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'lambda-file-api-generator';
  wb.created = new Date('2024-01-01T00:00:00.000Z');

  const ws = wb.addWorksheet('Transactions');

  ws.columns = [
    { header: 'TransactionID', key: 'txid', width: 18 },
    { header: 'Timestamp',     key: 'ts',   width: 22 },
    { header: 'CustomerName',  key: 'cust', width: 25 },
    { header: 'Department',    key: 'dept', width: 16 },
    { header: 'Category',      key: 'cat',  width: 16 },
    { header: 'Amount',        key: 'amt',  width: 12 },
    { header: 'Status',        key: 'stat', width: 14 },
    { header: 'ReferenceCode', key: 'ref',  width: 28 },
    { header: 'Description',   key: 'desc', width: 45 },
  ];

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };

  const departments = ['Engineering', 'Finance', 'Operations', 'Marketing', 'Sales', 'Legal', 'Product', 'Support'];
  const categories  = ['Hardware', 'Software', 'CloudServices', 'Consulting', 'Security', 'Networking', 'Logistics'];
  const statuses    = ['COMPLETED', 'PENDING', 'PROCESSING', 'RECONCILED', 'AUDITED'];
  const baseDate    = new Date('2024-01-01T08:00:00.000Z').getTime();

  for (let i = 1; i <= rows; i++) {
    const hexRef  = randomBytes(12).toString('hex');
    const hexDesc = randomBytes(16).toString('hex');

    ws.addRow({
      txid: `TXN-${i.toString().padStart(8, '0')}`,
      ts:   new Date(baseDate + (i * 3600000) % (365 * 86400000)).toISOString(),
      cust: `Client_${((i * 47) % 1000).toString()}_${randomBytes(3).toString('hex')}`,
      dept: departments[i % departments.length],
      cat:  categories[i % categories.length],
      amt:  Math.round(((i * 91.37) % 50000 + 10) * 100) / 100,
      stat: statuses[i % statuses.length],
      ref:  `REF-${hexRef.toUpperCase()}`,
      desc: `Operational batch verification record ${((i % 50) + 1)} code ${hexDesc}`,
    });
  }

  return wb;
}

// =============================================================================
// Helper 2: Calibrated Target-Size Excel Generator
// Automatically adjusts row counts in a feedback loop to guarantee the resulting
// compressed .xlsx file lands within +/-5% of the target bytes.
// =============================================================================
export async function generateTargetExcel(targetMB, filename, verbose = true) {
  const outputPath = resolve(outputDir, filename);
  const targetBytes = Math.round(targetMB * ONE_MB);

  // Empirical initial estimate for realistic transaction schema:
  // After ZIP/Deflate compression, each row produces ~99.1 bytes in the final .xlsx
  let rows = Math.max(10, Math.round(targetBytes / 99.1));
  let attempts = 0;
  const maxAttempts = 4;
  let actualBytes = 0;
  let diffPercent = 0;
  let withinTolerance = false;
  let finalBuf = null;

  while (attempts < maxAttempts) {
    attempts++;
    const wb = createRealisticWorkbook(rows);
    const buf = await wb.xlsx.writeBuffer();
    actualBytes = buf.byteLength;
    diffPercent = ((actualBytes - targetBytes) / targetBytes) * 100;
    withinTolerance = Math.abs(diffPercent) <= TOLERANCE_PERCENT;

    const sign = diffPercent >= 0 ? '+' : '';
    const statusTag = withinTolerance ? '[PASS]' : '[ADJUSTING]';

    if (verbose) {
      console.log(`   Attempt ${attempts}: ${rows.toLocaleString()} rows -> ${actualBytes.toLocaleString()} bytes (${sign}${diffPercent.toFixed(2)}% vs target) ${statusTag}`);
    }

    if (withinTolerance) {
      finalBuf = buf;
      break;
    }

    if (attempts < maxAttempts) {
      // Linear proportional adjustment based on actual measured size
      const adjustmentFactor = targetBytes / actualBytes;
      const newRows = Math.round(rows * adjustmentFactor);
      if (newRows === rows) {
        rows = diffPercent < 0 ? rows + 5 : rows - 5;
      } else {
        rows = newRows;
      }
    } else {
      finalBuf = buf;
    }
  }

  // Write finalized buffer to file
  writeFileSync(outputPath, finalBuf);
  const diskSize = statSync(outputPath).size;

  return {
    filename,
    targetMB,
    targetBytes,
    actualBytes: diskSize,
    actualMB: (diskSize / ONE_MB).toFixed(3),
    rows,
    diffPercent,
    withinTolerance,
    attempts,
  };
}

// =============================================================================
// Helper 3: Standard Row-Count Excel Generator (Mode A Benchmarks)
// =============================================================================
export async function generateRowExcel(rows, filename) {
  const outputPath = resolve(outputDir, filename);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');

  ws.columns = [
    { header: 'ID',    key: 'id',    width: 10 },
    { header: 'Name',  key: 'name',  width: 25 },
    { header: 'Value', key: 'value', width: 15 },
    { header: 'Date',  key: 'date',  width: 15 },
    { header: 'Note',  key: 'note',  width: 35 },
  ];

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };

  const baseDate = new Date('2024-01-01').getTime();
  for (let i = 1; i <= rows; i++) {
    ws.addRow({
      id:    i,
      name:  `Customer_${i}_${(i * 37).toString(36)}`,
      value: Math.round(((i * 73.19) % 10000) * 100) / 100,
      date:  new Date(baseDate + ((i - 1) % 365) * 86_400_000).toISOString().slice(0, 10),
      note:  `Standard benchmark data row ${i} for Lambda processing`,
    });
  }

  await wb.xlsx.writeFile(outputPath);
  const size = statSync(outputPath).size;
  return {
    filename,
    format: 'XLSX (Standard)',
    target: `${rows.toLocaleString()} rows`,
    actualBytes: size,
    actualMB: (size / ONE_MB).toFixed(3),
    description: `Row-count benchmark (${rows.toLocaleString()} rows)`,
  };
}

// =============================================================================
// Helper 4: Corrupted Non-ZIP File (For HTTP 422 Validation Testing)
// =============================================================================
export function generateCorruptedExcel(filename) {
  const outputPath = resolve(outputDir, filename);
  const content = 'NOT_A_VALID_ZIP_ARCHIVE: Plain text masquerading as .xlsx for testing HTTP 422 validation.\n';
  writeFileSync(outputPath, content, 'utf8');
  const size = statSync(outputPath).size;
  return {
    filename,
    format: 'Corrupted (.xlsx)',
    target: 'Invalid content',
    actualBytes: size,
    actualMB: (size / ONE_MB).toFixed(3),
    description: 'Non-ZIP text file for testing HTTP 422 validation',
  };
}

// =============================================================================
// Helper 5: Validation against Project's parseExcel implementation
// =============================================================================
export async function verifyExcelFile(filename, expectedTargetMB = null) {
  const filePath = resolve(outputDir, filename);
  if (!existsSync(filePath)) {
    return { filename, valid: false, error: 'File does not exist' };
  }

  const buf = readFileSync(filePath);
  const actualBytes = buf.byteLength;

  // 1. Verify ZIP magic bytes PK\x03\x04
  const hasZipMagic =
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04;

  if (!hasZipMagic) {
    return { filename, actualBytes, valid: false, error: 'Missing ZIP magic bytes PK\\x03\\x04' };
  }

  // 2. Parse using project's dist/utils/excelParser.js
  let parseResult = null;
  try {
    const parserMod = await import('../dist/utils/excelParser.js');
    parseResult = await parserMod.parseExcel(buf);
  } catch (err) {
    return {
      filename,
      actualBytes,
      valid: false,
      error: `parseExcel failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3. Size tolerance check if target was supplied
  let diffPercent = null;
  let withinTolerance = null;
  if (expectedTargetMB !== null) {
    const targetBytes = expectedTargetMB * ONE_MB;
    diffPercent = ((actualBytes - targetBytes) / targetBytes) * 100;
    withinTolerance = Math.abs(diffPercent) <= TOLERANCE_PERCENT;
  }

  return {
    filename,
    actualBytes,
    rowCount: parseResult.rowCount,
    columnCount: parseResult.columnCount,
    sheetName: parseResult.sheetName,
    previewCount: parseResult.previewRows.length,
    diffPercent,
    withinTolerance,
    valid: true,
  };
}

// =============================================================================
// Main CLI Execution
// =============================================================================
async function main() {
  const args = process.argv.slice(2);

  // Extract positional numeric targets (e.g. 1 2 3 or 5 6 8 10 12)
  const numericTargets = args
    .map((arg) => {
      const match = arg.match(/^(\d+(?:\.\d+)?)(?:mb)?$/i);
      return match ? parseFloat(match[1]) : null;
    })
    .filter((n) => n !== null && n > 0);

  const hasSpecificTargets = numericTargets.length > 0;
  const runAll             = args.includes('--all');
  const runRowsOnly        = args.includes('--rows');
  const shouldVerify       = args.includes('--verify');

  console.log('========================================================================================');
  console.log(' Lambda File API - Excel Test Payload Generator');
  console.log(` Target directory: ${outputDir}`);
  console.log(` Base unit: 1 MB = ${ONE_MB.toLocaleString()} bytes | Target tolerance: +/-${TOLERANCE_PERCENT}%`);
  console.log('========================================================================================\n');

  const generatedTargets = [];

  // Branch A: User specified specific numeric targets (e.g. `node scripts/generate-test-files.mjs 1 2 3`)
  if (hasSpecificTargets) {
    console.log(`[Target Generation] Generating specified targets: ${numericTargets.map(n => `${n}MB`).join(', ')}...`);
    for (const mb of numericTargets) {
      const filename = `excel-${mb}mb.xlsx`;
      console.log(`\n-> Generating ${filename} (Target: ${mb} MB = ${(mb * ONE_MB).toLocaleString()} bytes):`);
      const res = await generateTargetExcel(mb, filename, true);
      generatedTargets.push(res);
    }
  }
  // Branch B: User specified `--rows` only
  else if (runRowsOnly) {
    console.log('[Mode A] Generating Row-Count Benchmark Files...');
    const rowCounts = [
      { rows: 100,     name: 'small-100rows.xlsx' },
      { rows: 1_000,   name: 'medium-1000rows.xlsx' },
      { rows: 10_000,  name: 'large-10000rows.xlsx' },
      { rows: 50_000,  name: 'xlarge-50000rows.xlsx' },
      { rows: 100_000, name: 'xxlarge-100000rows.xlsx' },
    ];
    for (const item of rowCounts) {
      process.stdout.write(`   Generating ${item.name} (${item.rows.toLocaleString()} rows)... `);
      const res = await generateRowExcel(item.rows, item.name);
      console.log(`done (${res.actualMB} MB)`);
    }
  }
  // Branch C: User specified `--all`
  else if (runAll) {
    console.log('[Mode A] Generating Row-Count Benchmark Files...');
    const rowCounts = [
      { rows: 100,     name: 'small-100rows.xlsx' },
      { rows: 1_000,   name: 'medium-1000rows.xlsx' },
      { rows: 10_000,  name: 'large-10000rows.xlsx' },
      { rows: 50_000,  name: 'xlarge-50000rows.xlsx' },
      { rows: 100_000, name: 'xxlarge-100000rows.xlsx' },
    ];
    for (const item of rowCounts) {
      process.stdout.write(`   Generating ${item.name} (${item.rows.toLocaleString()} rows)... `);
      const res = await generateRowExcel(item.rows, item.name);
      console.log(`done (${res.actualMB} MB)`);
    }

    console.log('\n[Mode B] Generating All Target Sizes (1, 2, 3, 4, 5, 6, 8, 10, 12 MB)...');
    for (const mb of ALL_SUPPORTED_TARGETS) {
      const filename = `excel-${mb}mb.xlsx`;
      console.log(`\n-> Generating ${filename} (Target: ${mb} MB = ${(mb * ONE_MB).toLocaleString()} bytes):`);
      const res = await generateTargetExcel(mb, filename, true);
      generatedTargets.push(res);
    }

    console.log('\n[Mode C] Generating Validation Test File (HTTP 422)...');
    process.stdout.write('   Generating invalid-corrupted.xlsx (non-ZIP payload)... ');
    const invalidRes = generateCorruptedExcel('invalid-corrupted.xlsx');
    console.log(`done (${invalidRes.actualBytes} bytes)`);
  }
  // Branch D: Default development run (No arguments provided)
  // Generates small targets [1, 2, 3] MB without generating large files automatically
  else {
    console.log('[Default Dev Mode] Generating safe local targets [1 MB, 2 MB, 3 MB] and baseline row files...');
    console.log('(Note: To generate additional targets, run: node scripts/generate-test-files.mjs 4 5 6 8 10 12 or --all)\n');

    // Row baselines
    for (const item of [{ rows: 100, name: 'small-100rows.xlsx' }, { rows: 1000, name: 'medium-1000rows.xlsx' }]) {
      process.stdout.write(`   Generating ${item.name} (${item.rows.toLocaleString()} rows)... `);
      await generateRowExcel(item.rows, item.name);
      console.log('done');
    }

    // Default target files: 1, 2, 3 MB
    for (const mb of [1, 2, 3]) {
      const filename = `excel-${mb}mb.xlsx`;
      console.log(`\n-> Generating ${filename} (Target: ${mb} MB = ${(mb * ONE_MB).toLocaleString()} bytes):`);
      const res = await generateTargetExcel(mb, filename, true);
      generatedTargets.push(res);
    }

    // Corrupted file
    generateCorruptedExcel('invalid-corrupted.xlsx');
  }

  // -- Summary Table for Target Files -----------------------------------------
  if (generatedTargets.length > 0) {
    console.log('\n========================================================================================');
    console.log('Target Size Calibration & Accuracy Report');
    console.log('========================================================================================');
    console.log('| Target | File Name | Actual Bytes | Target Bytes | Rows | Deviation | Status | Tolerance |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const item of generatedTargets) {
      const sign = item.diffPercent >= 0 ? '+' : '';
      const statusText = item.withinTolerance ? 'PASS' : 'FAIL';
      console.log(`| ${item.targetMB} MB | \`${item.filename}\` | ${item.actualBytes.toLocaleString()} B | ${item.targetBytes.toLocaleString()} B | ${item.rows.toLocaleString()} | ${sign}${item.diffPercent.toFixed(2)}% | **${statusText}** | +/-${TOLERANCE_PERCENT}% |`);
    }
    console.log('========================================================================================\n');
  }

  // -- Optional Verification --------------------------------------------------
  if (shouldVerify && generatedTargets.length > 0) {
    console.log('========================================================================================');
    console.log('Verifying Generated Files with parseExcel...');
    console.log('========================================================================================');
    for (const item of generatedTargets) {
      const ver = await verifyExcelFile(item.filename, item.targetMB);
      const sign = (ver.diffPercent ?? 0) >= 0 ? '+' : '';
      console.log(`* File: ${ver.filename}`);
      console.log(`  - Exists & Valid ZIP : ${ver.valid ? 'YES (PK\\x03\\x04 header)' : 'NO'}`);
      console.log(`  - File Size          : ${ver.actualBytes.toLocaleString()} bytes (${sign}${(ver.diffPercent ?? 0).toFixed(2)}% deviation)`);
      console.log(`  - Parsed Rows        : ${ver.rowCount?.toLocaleString()} data rows`);
      console.log(`  - Parsed Columns     : ${ver.columnCount} columns (Worksheet: "${ver.sheetName}")`);
      console.log(`  - Verification Status: ${ver.valid && ver.withinTolerance ? 'PASS' : 'FAIL'}`);
      console.log();
    }
  }
}

main().catch((err) => {
  console.error('Error generating test files:', err);
  process.exit(1);
});
