import { APIGatewayProxyResultV2 } from 'aws-lambda';

/**
 * Build a consistent JSON response for API Gateway HTTP API v2.
 */
export function jsonResponse(
  statusCode: number,
  body: Record<string, unknown>,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
