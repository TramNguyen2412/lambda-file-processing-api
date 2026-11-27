import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

export interface SqsSenderLike {
  sendMessage(queueUrl: string, messageBody: string): Promise<{ messageId?: string }>;
}

let sqsClient: SQSClient | null = null;
let overrideSender: SqsSenderLike | null = null;

function getClient(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({ region: process.env.AWS_REGION });
  }
  return sqsClient;
}

/**
 * Override SQS client for local testing without AWS.
 */
export function setSqsSenderForTest(sender: SqsSenderLike | null): void {
  overrideSender = sender;
}

export async function sendSqsMessage(
  queueUrl: string,
  messageBody: string,
): Promise<{ messageId?: string }> {
  if (overrideSender) {
    return overrideSender.sendMessage(queueUrl, messageBody);
  }
  const res = await getClient().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: messageBody,
    }),
  );
  return { messageId: res.MessageId };
}
