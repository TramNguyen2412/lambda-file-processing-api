import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';

/**
 * GET /health
 * Returns Lambda runtime metadata to confirm the function is alive
 * and to show configuration values (memory, remaining time, Node.js version).
 */
export const handler = async (
  _event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'ok',
      timestamp: new Date().toISOString(),
      runtime: process.version, // e.g. "v24.x.x"
      lambda: {
        functionName:    context.functionName,
        functionVersion: context.functionVersion,
        memoryLimitMB:   context.memoryLimitInMB,
        remainingTimeMS: context.getRemainingTimeInMillis(),
        logGroupName:    context.logGroupName,
        logStreamName:   context.logStreamName,
      },
    }),
  };
};
