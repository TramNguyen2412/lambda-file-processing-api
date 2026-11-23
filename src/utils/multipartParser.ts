/**
 * src/utils/multipartParser.ts
 * Lightweight helper to extract binary file payload from multipart/form-data
 * without requiring heavy external dependencies.
 *
 * If the payload is raw binary (starts with ZIP signature PK\x03\x04), it returns
 * the buffer untouched.
 * If the payload is multipart/form-data, it extracts the file data between the
 * boundary headers and the trailing boundary marker.
 */

export function extractFileBuffer(buffer: Buffer, contentType?: string): Buffer {
  if (buffer.length < 4) {
    return buffer;
  }

  // 1. If buffer already starts with standard ZIP/XLSX magic bytes (PK\x03\x04 = 0x50 0x4B 0x03 0x04)
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return buffer;
  }

  // 2. Check if content-type or initial buffer bytes indicate multipart/form-data
  const isMultipart =
    contentType?.toLowerCase().includes('multipart/form-data') ||
    buffer.subarray(0, 120).includes(Buffer.from('Content-Disposition: form-data'));

  if (!isMultipart) {
    return buffer;
  }

  // Find header separator \r\n\r\n (0x0d 0x0a 0x0d 0x0a) or \n\n (0x0a 0x0a)
  let headerEnd = buffer.indexOf('\r\n\r\n');
  let dataStart = -1;
  if (headerEnd !== -1) {
    dataStart = headerEnd + 4;
  } else {
    headerEnd = buffer.indexOf('\n\n');
    if (headerEnd !== -1) {
      dataStart = headerEnd + 2;
    }
  }

  if (dataStart === -1 || dataStart >= buffer.length) {
    return buffer;
  }

  // Find trailing boundary marker: \r\n--
  const trailingBoundary = buffer.lastIndexOf('\r\n--');
  const dataEnd = trailingBoundary > dataStart ? trailingBoundary : buffer.length;

  const extracted = buffer.subarray(dataStart, dataEnd);

  // If extracted part has ZIP signature, return it
  if (extracted.length >= 4 && extracted[0] === 0x50 && extracted[1] === 0x4b) {
    return extracted;
  }

  return extracted.length > 0 ? extracted : buffer;
}
