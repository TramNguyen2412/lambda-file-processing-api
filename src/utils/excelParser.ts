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
