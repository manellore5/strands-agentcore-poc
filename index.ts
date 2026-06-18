/**
 * index.ts — Strands agent inside an AgentCore-compatible Express server.
 *
 * What this file does, in plain English:
 * 1. Defines a "calculator" tool the LLM can call.
 * 2. Builds a Strands Agent that uses Amazon Bedrock (Claude) as its brain.
 * 3. Wraps the agent in an Express server exposing the two endpoints
 *    AgentCore Runtime requires: GET /ping and POST /invocations.
 *
 * AgentCore Runtime is essentially a managed container host that speaks
 * a fixed HTTP contract. If our server speaks that contract, AgentCore
 * can deploy, scale, isolate sessions, log, and monitor it for us.
 */

// MUST be the first import: loads variables from a local `.env` file into
// process.env before any other code reads them. Has no effect in production
// (no .env file is shipped with the Docker image), so production keeps
// getting its env vars from AgentCore Runtime's --environment-variables flag.
import 'dotenv/config';

import { z } from 'zod';
import * as strands from '@strands-agents/sdk';
// ⬇️ NEW: BedrockModel lives in a separate subpath; this import is the only
// structural change vs the Anthropic version.
import { BedrockModel } from '@strands-agents/sdk';
import express, { type Request, type Response } from 'express';

// AgentCore Runtime sends traffic to whatever port our container listens on.
// 8080 is the convention used in AWS examples.
const PORT = process.env.PORT || 8080;

// ─────────────────────────────────────────────────────────────────────────────
// 1) Define a tool
// ─────────────────────────────────────────────────────────────────────────────
// A "tool" is a function the LLM is allowed to call. Strands uses Zod to
// describe the tool's inputs — this gives us TWO benefits:
//
//   a) Type safety at compile time (TypeScript knows `input.a` is a number).
//   b) Runtime validation: if the LLM hallucinates bad arguments, Zod rejects
//      them before our `callback` runs, and Strands feeds the error back to
//      the LLM so it can correct itself.
//
// The `description` is what the LLM actually reads to decide whether to call
// this tool. Write it like a docstring — clear, action-oriented.
const calculatorTool = strands.tool({
  name: 'calculator',
  description:
    'Performs basic arithmetic operations (add, subtract, multiply, divide) on two numbers. Use this whenever the user asks for a calculation.',
  inputSchema: z.object({
    operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
    a: z.number(),
    b: z.number(),
  }),
  callback: (input): number => {
    switch (input.operation) {
      case 'add':
        return input.a + input.b;
      case 'subtract':
        return input.a - input.b;
      case 'multiply':
        return input.a * input.b;
      case 'divide':
        if (input.b === 0) {
          // Throwing here is fine — Strands surfaces the error back to the LLM,
          // which will typically apologise and explain why it can't divide by zero.
          throw new Error('Cannot divide by zero');
        }
        return input.a / input.b;
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b) Define a SECOND tool — get current weather for any city
// ─────────────────────────────────────────────────────────────────────────────
// Uses Open-Meteo's free public API (no API key needed).
// Demonstrates: external HTTP calls inside a tool, error handling,
// chaining two API calls (geocode → forecast).
//
// Flow when the LLM calls this tool with `city: "Tokyo"`:
//   1. Geocoding API turns "Tokyo" → lat/lng coordinates
//   2. Forecast API uses those coordinates to fetch current weather
//   3. We return a tidy object the LLM can describe to the user
const weatherTool = strands.tool({
  name: 'get_current_weather',
  description:
    'Fetches the current real-world weather for any city worldwide. Use this whenever the user asks about weather, temperature, wind, or current conditions for a specific city. Returns temperature in Celsius, wind speed in km/h, and a weather condition code.',
  inputSchema: z.object({
    city: z
      .string()
      .describe('The city name, e.g. "Tokyo", "New York", "Paris"'),
  }),
  callback: async (input) => {
    // STEP 1: Geocode the city name → latitude/longitude
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(input.city)}&count=1`;
    const geoRes = await fetch(geoUrl);
    if (!geoRes.ok) {
      throw new Error(`Geocoding failed: HTTP ${geoRes.status}`);
    }
    const geoData = (await geoRes.json()) as {
      results?: Array<{
        latitude: number;
        longitude: number;
        name: string;
        country: string;
      }>;
    };
    if (!geoData.results || geoData.results.length === 0) {
      throw new Error(`City not found: "${input.city}". Please check the spelling.`);
    }
    const { latitude, longitude, name, country } = geoData.results[0];

    // STEP 2: Fetch current weather using those coordinates
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,wind_speed_10m,weather_code`;
    const weatherRes = await fetch(weatherUrl);
    if (!weatherRes.ok) {
      throw new Error(`Weather lookup failed: HTTP ${weatherRes.status}`);
    }
    const weatherData = (await weatherRes.json()) as {
      current: {
        temperature_2m: number;
        wind_speed_10m: number;
        weather_code: number;
      };
    };

    // STEP 3: Return a structured result the LLM can describe
    return {
      city: name,
      country,
      temperatureCelsius: weatherData.current.temperature_2m,
      windSpeedKmh: weatherData.current.wind_speed_10m,
      weatherCode: weatherData.current.weather_code,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Build the agent
// ─────────────────────────────────────────────────────────────────────────────

// The API key comes from the ANTHROPIC_API_KEY environment variable. NEVER
// hard-code it here — that's how keys get leaked to git, screenshots, logs.

// Bedrock uses AWS IAM auth — no API key needed.
// On laptop: uses credentials from `aws configure`.
// On AgentCore Runtime: uses the IAM role we attached.
const agent = new strands.Agent({
  model: new BedrockModel({
region: 'us-east-1',
    modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',  }),
  tools: [calculatorTool, weatherTool],
  systemPrompt:
    'You are a helpful assistant. When the user asks for a calculation, use the calculator tool. When the user asks about the weather, use the get_current_weather tool to fetch real data — never make up weather information.',
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) Wrap the agent in an AgentCore-compatible HTTP server
// ─────────────────────────────────────────────────────────────────────────────
const app = express();

// ── REQUIRED ENDPOINT #1: GET /ping ──
// AgentCore polls this to check whether our container is healthy.
// Must return 200 with a body that includes a status field.
app.get('/ping', (_req: Request, res: Response) => {
  res.json({
    status: 'Healthy',
    time_of_last_update: Math.floor(Date.now() / 1000),
  });
});

// ── REQUIRED ENDPOINT #2: POST /invocations ──
// This is where actual user prompts arrive. AWS sends the payload as raw
// binary bytes (not JSON), so we use express.raw middleware to grab them.
//
// Important: the wildcard content-type `*/*` is intentional — different AWS
// SDKs send different Content-Type headers; this accepts them all.
app.post(
  '/invocations',
  express.raw({ type: '*/*', limit: '10mb' }),
  async (req: Request, res: Response) => {
    try {
      // Decode the raw bytes into a UTF-8 string (the user's prompt).
      const prompt = new TextDecoder().decode(req.body);
      console.log('Received prompt:', prompt);

      // Run the agent. This is where the magic happens — Strands handles
      // the LLM call(s), tool execution, and looping until the agent decides
      // it's done.
      const response = await agent.invoke(prompt);

      // Send the full AgentResult back. The caller can pluck out whatever
      // they need (final text, message history, stop reason, etc.).
      return res.json({ response });
    } catch (err) {
      console.error('Error processing /invocations request:', err);
      return res.status(500).json({
        error: 'Internal server error',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 4) Boot the server
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 AgentCore Runtime server listening on port ${PORT}`);
  console.log(`📍 Endpoints:`);
  console.log(`   GET  http://0.0.0.0:${PORT}/ping`);
  console.log(`   POST http://0.0.0.0:${PORT}/invocations`);
});
