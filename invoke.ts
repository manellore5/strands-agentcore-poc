/**
 * invoke.ts — Test client for the deployed AgentCore agent.
 *
 * Run: npm run invoke
 *
 * Uses the AWS SDK to invoke your deployed AgentCore Runtime. The SDK
 * handles all the encoding/signing/auth headers for you — much cleaner
 * than wrestling with raw AWS CLI base64 payloads.
 */

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import crypto from 'node:crypto';

// ── YOUR DEPLOYED RUNTIME ─────────────────────────────────────────────────
const YOUR_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID ?? '<YOUR_ACCOUNT_ID>';
const YOUR_RUNTIME_ID = 'my_agent_service-VhlEcEFXr1';
const REGION = 'us-east-1';
// ──────────────────────────────────────────────────────────────────────────

// ── THE PROMPT TO SEND ────────────────────────────────────────────────────
// Change this string to test different agent capabilities. The current
// prompt exercises BOTH tools (weather + calculator) in a single conversation.
const PROMPT = 'What is the weather in London, and what is 256 divided by 8?';
// ──────────────────────────────────────────────────────────────────────────

const client = new BedrockAgentCoreClient({ region: REGION });

const command = new InvokeAgentRuntimeCommand({
  // AgentCore requires a session ID of at least 33 characters. randomUUID()
  // gives us 36 chars of high-entropy randomness — comfortably over the
  // minimum and unique across calls.
  runtimeSessionId: `test-session-${Date.now()}-${crypto.randomUUID()}`,

  agentRuntimeArn: `arn:aws:bedrock-agentcore:${REGION}:${YOUR_ACCOUNT_ID}:runtime/${YOUR_RUNTIME_ID}`,

  // DEFAULT is the qualifier for the live version of your runtime.
  qualifier: 'DEFAULT',

  // The payload is sent as bytes — that's why our server uses express.raw().
  payload: new TextEncoder().encode(PROMPT),
});

console.log(`Sending prompt: "${PROMPT}"\n`);

const response = await client.send(command);
const textResponse = await response.response!.transformToString();

console.log('Response:\n');
console.log(textResponse);