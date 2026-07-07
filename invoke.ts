import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import crypto from 'crypto';

const client = new BedrockAgentCoreClient({ region: 'us-east-1' });

const RUNTIME_ARN =
  'arn:aws:bedrock-agentcore:us-east-1:362249012325:runtime/my_agent_service-VhlEcEFXr1';

// ONE session ID for the whole conversation — this is the key change!
const conversationSessionId = crypto.randomUUID();

async function ask(prompt: string, sessionId: string): Promise<string> {
  console.log(`\n👤 You: ${prompt}`);
  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: RUNTIME_ARN,
    runtimeSessionId: sessionId,
    payload: new TextEncoder().encode(prompt),
  });
  const response = await client.send(command);
  const body = await response.response?.transformToString();
  const parsed = JSON.parse(body ?? '{}');
  const text =
    parsed?.response?.lastMessage?.content?.[0]?.text ?? JSON.stringify(parsed);
  console.log(`🤖 Agent: ${text}`);
  return text;
}

async function main() {
  console.log('=== Conversation 1: same session (should remember) ===');
  console.log(`Session ID: ${conversationSessionId}`);

  await ask('My name is Kiran and my favorite city is Sydney.', conversationSessionId);
  await ask('What is my name?', conversationSessionId);
  await ask('What is the weather in my favorite city?', conversationSessionId);

  console.log('\n=== Conversation 2: NEW session (should forget) ===');
  const freshSessionId = crypto.randomUUID();
  console.log(`Session ID: ${freshSessionId}`);

  await ask('What is my name?', freshSessionId);
}

main().catch(console.error);