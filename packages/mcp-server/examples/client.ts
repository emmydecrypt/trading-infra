/**
 * Example MCP client that:
 *   1. Spawns the MCP server as a child process over stdio.
 *   2. Initializes the MCP session.
 *   3. Lists available tools.
 *   4. Calls get_candles + get_signal on BTCUSDT.
 *   5. Prints the results.
 *
 * Run with:  npm run example
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ENTRY = path.resolve(__dirname, '../src/index.ts');

async function main(): Promise<void> {
  console.log(`[client] spawning server: ${SERVER_ENTRY}`);
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', SERVER_ENTRY],
    env: { ...process.env } as Record<string, string>,
  });

  const client = new Client(
    {
      name: 'bitget-mcp-example-client',
      version: '0.1.0',
    },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    console.log('[client] connected, listing tools...');

    const { tools } = await client.listTools();
    console.log(`[client] server exposes ${tools.length} tools:`);
    for (const t of tools) {
      console.log(`  - ${t.name}: ${t.description}`);
    }

    console.log('\n[client] calling get_candles BTCUSDT 15m limit=80 ...');
    const candlesRes = await client.callTool({
      name: 'get_candles',
      arguments: { symbol: 'BTCUSDT', granularity: '15m', limit: 80 },
    });
    const candlesText = ((candlesRes.content as Array<{ type: 'text'; text: string }>)[0]!).text;
    const candles = JSON.parse(candlesText) as Array<Record<string, number>>;
    console.log(`[client] got ${candles.length} candles; last close = ${candles.at(-1)?.close}`);

    console.log('\n[client] calling get_signal BTCUSDT 15m ...');
    const signalRes = await client.callTool({
      name: 'get_signal',
      arguments: { symbol: 'BTCUSDT', granularity: '15m', limit: 80 },
    });
    const signalText = ((signalRes.content as Array<{ type: 'text'; text: string }>)[0]!).text;
    const parsed = JSON.parse(signalText) as {
      symbol: string;
      granularity: string;
      candles: number;
      signal: {
        side: 'long' | 'short' | 'none';
        strength: number;
        rationale: string[];
        indicators: Record<string, unknown>;
        price: number;
        asOf: number;
      };
    };
    console.log('Signal:', JSON.stringify(parsed, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('[client] error:', err);
  process.exit(1);
});