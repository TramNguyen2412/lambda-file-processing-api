import ExcelJS from 'exceljs';

export interface GenerateResult {
  buffer: Buffer;
  rowCount: number;
  fileSizeBytes: number;
  fileSizeMB: number;
  elapsedMs: number;
}

/**
 * Generate an Excel workbook with fake sales data and return it as a Buffer.
 *
 * NOTE: The entire workbook is built in-memory before returning.
 * XLSX is ZIP-compressed, so actual file size is much smaller than raw data.
 * e.g. 50,000 rows ≈ 3–6 MB compressed (measure with generate-test-files.sh).
 */
export async function generateExcel(numRows: number): Promise<GenerateResult> {
  const startTime = Date.now();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'lambda-file-api';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Report');

  sheet.columns = [
    { header: 'ID',       key: 'id',       width: 10 },
    { header: 'Date',     key: 'date',      width: 15 },
    { header: 'Name',     key: 'name',      width: 20 },
    { header: 'Category', key: 'category',  width: 15 },
    { header: 'Qty',      key: 'qty',       width: 10 },
    { header: 'Price',    key: 'price',     width: 12 },
    { header: 'Total',    key: 'total',     width: 14 },
    { header: 'Status',   key: 'status',    width: 12 },
  ];

  // Style the header row
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF366092' },
  };
  headerRow.alignment = { horizontal: 'center' };

  const statuses   = ['Completed', 'Pending', 'Cancelled', 'Processing'];
  const categories = ['Electronics', 'Clothing', 'Food', 'Books', 'Sports'];
  const baseDate   = new Date('2024-01-01').getTime();

  for (let i = 1; i <= numRows; i++) {
    const qty   = Math.ceil(Math.random() * 100);
    const price = Math.round((Math.random() * 490 + 10) * 100) / 100;
    sheet.addRow({
      id:       i,
      date:     new Date(baseDate + i * 86_400_000).toISOString().slice(0, 10),
      name:     `Customer_${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      category: categories[i % categories.length],
      qty,
      price,
      total:    Math.round(qty * price * 100) / 100,
      status:   statuses[i % statuses.length],
    });
  }

  const rawBuffer = await workbook.xlsx.writeBuffer();
  const buffer    = Buffer.from(rawBuffer);
  const elapsedMs = Date.now() - startTime;

  return {
    buffer,
    rowCount:      numRows,
    fileSizeBytes: buffer.byteLength,
    fileSizeMB:    Math.round((buffer.byteLength / (1024 * 1024)) * 1000) / 1000,
    elapsedMs,
  };
}
