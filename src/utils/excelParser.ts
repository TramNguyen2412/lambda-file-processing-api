import ExcelJS from 'exceljs';

export interface ParseResult {
  sheetName: string;
  /** Number of data rows, excluding the header row */
  rowCount: number;
  columnCount: number;
  fileSizeBytes: number;
  fileSizeKB: number;
  /** Up to 5 data rows for preview */
  previewRows: Record<string, unknown>[];
}

/**
 * Parse an Excel (.xlsx) Buffer and return metadata + a small preview.
 * Wraps ExcelJS which loads the full workbook into memory.
 */
export async function parseExcel(buffer: Buffer): Promise<ParseResult> {
  const workbook = new ExcelJS.Workbook();
  // Cast buffer to any due to type incompatibility between modern @types/node Buffer and exceljs index.d.ts
  await workbook.xlsx.load(buffer as any);

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error('File Excel không có worksheet nào');
  }

  // Collect header names from row 1
  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell) => {
    headers.push(String(cell.value ?? ''));
  });

  // Collect up to 5 data rows (rows 2-6)
  const previewRows: Record<string, unknown>[] = [];
  const previewLimit = Math.min(6, sheet.rowCount);
  for (let r = 2; r <= previewLimit; r++) {
    const row: Record<string, unknown> = {};
    sheet.getRow(r).eachCell((cell, colNum) => {
      const header = headers[colNum - 1] ?? `col${colNum}`;
      row[header] = cell.value;
    });
    previewRows.push(row);
  }

  return {
    sheetName:    sheet.name,
    rowCount:     Math.max(0, sheet.rowCount - 1), // subtract header
    columnCount:  sheet.columnCount,
    fileSizeBytes: buffer.byteLength,
    fileSizeKB:   Math.round(buffer.byteLength / 1024),
    previewRows,
  };
}

export interface ParsedExcelRow {
  rowIndex: number;
  data: Record<string, unknown>;
}

export interface FullParseResult {
  sheetName: string;
  headers: string[];
  rowCount: number;
  columnCount: number;
  rows: ParsedExcelRow[];
}

function normalizeCellValue(val: unknown): unknown {
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (val && typeof val === 'object' && 'result' in val) {
    return (val as { result: unknown }).result;
  }
  return val ?? null;
}

/**
 * Parse every data row of the first worksheet in an Excel (.xlsx) Buffer.
 * Validates the ZIP/PK signature first so corrupted files fail fast.
 */
export async function parseAllExcelRows(buffer: Buffer): Promise<FullParseResult> {
  if (buffer.byteLength < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('Invalid Excel file: missing ZIP/OpenXML signature');
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error('File Excel không có worksheet nào');
  }

  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell, colNum) => {
    const raw = String(cell.value ?? '').trim();
    headers[colNum - 1] = raw || `col${colNum}`;
  });

  if (headers.length === 0) {
    throw new Error('File Excel không có header row');
  }

  const rows: ParsedExcelRow[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const excelRow = sheet.getRow(r);
    if (!excelRow.hasValues) {
      continue;
    }
    const data: Record<string, unknown> = {};
    excelRow.eachCell({ includeEmpty: false }, (cell, colNum) => {
      const header = headers[colNum - 1] ?? `col${colNum}`;
      data[header] = normalizeCellValue(cell.value);
    });
    if (Object.keys(data).length > 0) {
      rows.push({ rowIndex: r - 1, data });
    }
  }

  return {
    sheetName: sheet.name,
    headers,
    rowCount: rows.length,
    columnCount: headers.length,
    rows,
  };
}
