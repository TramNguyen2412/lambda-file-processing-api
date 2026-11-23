#!/usr/bin/env node
/**
 * scripts/generate-test-files.mjs
 * Test payload generator supporting TWO testing modes:
 *
 * Mode A: Row-count Excel files (benchmark CPU, parse time, heap memory, and timeout)
 * Mode B: Target-size payloads (binary + low-compression Excel to test AWS payload limits)
 *
 * Run: npm run gen:test-files
 *   or: node scripts/generate-test-files.mjs [--rows | --targets | --all]
 */

import ExcelJS from 'exceljs';
import { statSync, mkdirSync, writeFileSync, openSync, writeSync, closeSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(__dirname, '..', 'test-files', 'generated');
mkdirSync(outputDir, { recursive: true });

const args = process.argv.slice(2);
const runRows    = args.length === 0 || args.includes('--rows') || args.includes('--all');
const runTargets = args.length === 0 || args.includes('--targets') || args.includes('--all');

// =============================================================================
// Helper 1: Standard Row-Count Excel Generator (Mode A)
// =============================================================================
async function generateRowExcel(rows, filename) {
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
    actualMB: (size / 1024 / 1024).toFixed(3),
    description: `Row-count benchmark (${rows} rows)`,
  };
}

// =============================================================================
// Helper 2: Binary Test Payload Generator (Mode B)
// Generates exact target size files using pseudo-random uncompressible bytes.
// =============================================================================
function generateBinaryPayload(targetMB, filename) {
  const outputPath = resolve(outputDir, filename);
  const targetBytes = Math.round(targetMB * 1024 * 1024);
  const fd = openSync(outputPath, 'w');

  const chunkBytes = 64 * 1024; // 64 KB chunk
  let written = 0;

  while (written < targetBytes) {
    const toWrite = Math.min(chunkBytes, targetBytes - written);
    const chunk = randomBytes(toWrite);
    writeSync(fd, chunk, 0, toWrite);
    written += toWrite;
  }
  closeSync(fd);

  const size = statSync(outputPath).size;
  return {
    filename,
    format: 'Binary (.bin)',
    target: `${targetMB} MB`,
    actualBytes: size,
    actualMB: (size / 1024 / 1024).toFixed(3),
    description: `Exact binary payload for boundary testing`,
  };
}

// =============================================================================
// Helper 3: Uncompressible Excel Generator (Mode B)
// Fills cells with random strings to resist ZIP compression, targeting ~1-5 MB.
// =============================================================================
async function generateUncompressibleExcel(approxTargetMB, filename) {
  const outputPath = resolve(outputDir, filename);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Uncompressible');

  ws.columns = [
    { header: 'ID',    key: 'id',    width: 10 },
    { header: 'Data1', key: 'data1', width: 32 },
    { header: 'Data2', key: 'data2', width: 32 },
    { header: 'Data3', key: 'data3', width: 32 },
  ];

  // Each row has ~100 bytes of random alphanumeric characters
  // Roughly 10,000 rows ~ 1 MB compressed XLSX
  const rows = Math.round(approxTargetMB * 9500);

  for (let i = 1; i <= rows; i++) {
    ws.addRow({
      id:    i,
      data1: randomBytes(16).toString('hex'),
      data2: randomBytes(16).toString('hex'),
      data3: randomBytes(16).toString('hex'),
    });
  }

  await wb.xlsx.writeFile(outputPath);
  const size = statSync(outputPath).size;
  return {
    filename,
    format: 'XLSX (Uncompressible)',
    target: `~${approxTargetMB} MB`,
    actualBytes: size,
    actualMB: (size / 1024 / 1024).toFixed(3),
    description: `High-entropy Excel to challenge Base64/Lambda limits`,
  };
}

// =============================================================================
// Main Execution
// =============================================================================
async function main() {
  console.log('======================================================================');
  console.log(` Generating Test Payloads in: ${outputDir}`);
  console.log('======================================================================\n');

  const catalog = [];

  // -- Mode A: Row-count benchmarks -------------------------------------------
  if (runRows) {
    console.log('[Mode A] Generating Row-Count Excel Files...');
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
      catalog.push({ ...res, mode: 'Mode A (Rows)' });
    }
    console.log();
  }

  // -- Mode B: Target-size benchmarks -----------------------------------------
  if (runTargets) {
    console.log('[Mode B] Generating Target-Size Payloads (1MB - 15MB)...');

    // 1. Uncompressible Excel files (1MB, 3MB, 5MB)
    const excelTargets = [
      { targetMB: 1, name: 'excel-target-1mb.xlsx' },
      { targetMB: 3, name: 'excel-target-3mb.xlsx' },
      { targetMB: 5, name: 'excel-target-5mb.xlsx' },
    ];
    for (const item of excelTargets) {
      process.stdout.write(`   Generating ${item.name} (target ~${item.targetMB} MB)... `);
      const res = await generateUncompressibleExcel(item.targetMB, item.name);
      console.log(`done (${res.actualMB} MB)`);
      catalog.push({ ...res, mode: 'Mode B (Target Excel)' });
    }

    // 2. Exact Binary Payloads (1MB, 3MB, 5MB, 6MB, 8MB, 10MB, 15MB)
    const binaryTargets = [1, 3, 5, 6, 8, 10, 15];
    for (const mb of binaryTargets) {
      const filename = `payload-${mb}mb.bin`;
      process.stdout.write(`   Generating ${filename} (${mb} MB exact binary)... `);
      const res = generateBinaryPayload(mb, filename);
      console.log(`done (${res.actualMB} MB)`);
      catalog.push({ ...res, mode: 'Mode B (Binary)' });
    }
    console.log();
  }

  // -- Print Summary Table ----------------------------------------------------
  console.log('========================================================================================');
  console.log('Test Payloads Catalog & Experiment Mapping');
  console.log('========================================================================================');
  console.log('| File Name | Format | Target | Actual Size | Primary Experiment |');
  console.log('|---|---|---|---|---|');
  for (const item of catalog) {
    let experiment = '';
    if (item.filename.includes('100rows')) experiment = 'Health & baseline verification';
    else if (item.filename.includes('1000rows')) experiment = 'Baseline parsing benchmark';
    else if (item.filename.includes('10000rows')) experiment = 'Moderate CPU/memory benchmark';
    else if (item.filename.includes('50000rows')) experiment = 'Heavy row processing test';
    else if (item.filename.includes('100000rows')) experiment = 'Extreme row processing (timeout/OOM test)';
    else if (item.filename.includes('1mb')) experiment = 'Safe upload baseline (< 4.5 MB raw limit)';
    else if (item.filename.includes('3mb')) experiment = 'Upper safe limit through API GW (base64 ~4 MB)';
    else if (item.filename.includes('5mb')) experiment = 'Hits Lambda 6MB event limit (base64 ~6.67 MB -> HTTP 500/502)';
    else if (item.filename.includes('6mb')) experiment = 'Exceeds Lambda sync boundary before Base64';
    else if (item.filename.includes('8mb')) experiment = 'Tests API Gateway proxy throughput under 10 MB';
    else if (item.filename.includes('10mb')) experiment = 'Exactly at API Gateway 10 MB edge limit';
    else if (item.filename.includes('15mb')) experiment = 'Exceeds API Gateway 10 MB limit -> Expect HTTP 413';

    console.log(`| \`${item.filename}\` | ${item.format} | ${item.target} | **${item.actualMB} MB** | ${experiment} |`);
  }
  console.log('========================================================================================\n');
}

main().catch((err) => {
  console.error('Error generating test files:', err);
  process.exit(1);
});
