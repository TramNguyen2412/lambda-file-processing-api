export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface LogFields {
  [key: string]: unknown;
}

const LAYER_VERSION = process.env.LAYER_VERSION ?? 'v1';

/**
 * Emit a structured JSON log line to CloudWatch Logs.
 * Includes layerVersion so Layer v1 vs v2 upgrades can be observed in logs.
 */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    layerVersion: LAYER_VERSION,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (event: string, fields?: LogFields) => log('INFO', event, fields),
  warn: (event: string, fields?: LogFields) => log('WARN', event, fields),
  error: (event: string, fields?: LogFields) => log('ERROR', event, fields),
};
