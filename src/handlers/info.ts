import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';

/**
 * GET /info
 * Returns the exact AWS limits, quotas, and architecture parameters
 * across all infrastructure layers in this project.
 */
export const handler = async (
  _event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project: 'AWS Lambda File Processing API',
      awsDocumentedLimits: {
        apiGatewayHttpApi: {
          maxRequestPayloadMB: 10,
          maxResponsePayloadMB: 10,
          maxIntegrationTimeoutSeconds: 29,
          rejectionStatusCode: 413,
          note: 'Hard quota enforced at edge proxy. Requests > 10 MB return HTTP 413 before reaching Lambda.',
        },
        lambdaSynchronousInvocation: {
          maxRequestPayloadMB: 6,
          maxResponsePayloadMB: 6,
          base64OverheadPercent: 33.3,
          effectiveRawUploadLimitMB: 4.5,
          note:
            'API Gateway v2 Base64-encodes binary bodies inside event JSON. ' +
            '6 MB limit applies to the ENTIRE event. Therefore, raw file upload limit is ~4.5 MB.',
          appliesTo: ['API Gateway HTTP API integration', 'Lambda Function URL (BUFFERED)'],
        },
        lambdaFunctionUrlBuffered: {
          maxRequestPayloadMB: 6,
          maxResponsePayloadMB: 6,
          maxTimeoutSeconds: 900,
          note: 'Identical 6 MB payload limits as API Gateway, but can execute up to 15 minutes without API Gateway 29s timeout.',
        },
        lambdaFunctionUrlResponseStream: {
          maxRequestPayloadMB: 6,
          maxResponsePayloadMB: 200,
          bandwidthRules: 'First 6 MB unthrottled; subsequent streaming bandwidth is capped at 2 MB/s (16 Mbps).',
          maxTimeoutSeconds: 900,
          note: 'RESPONSE_STREAM only relaxes the response payload quota (up to 200 MB). Request payload remains capped at 6 MB.',
        },
        lambdaComputeAndPackaging: {
          minMemoryMB: 128,
          maxMemoryMB: 10240,
          vcpuScaling: '1 full vCPU allocated per 1,769 MB memory.',
          maxTimeoutSeconds: 900,
          maxDeploymentZipSizeMB: 50,
          maxUnzippedPackageSizeMB: 250,
        },
      },
      currentFunctionContext: {
        functionName:    context.functionName,
        memoryLimitMB:   context.memoryLimitInMB,
        remainingTimeMS: context.getRemainingTimeInMillis(),
        nodeRuntime:     process.version,
      },
    }),
  };
};
