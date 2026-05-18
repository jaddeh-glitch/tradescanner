const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const BASE_URL = process.env.TRADESCANNER_URL || 'http://localhost:3000';

const server = new McpServer({
  name: 'tradescanner',
  version: '1.0.0',
});

server.tool(
  'get_stock_price',
  'Get the live price, change, and session state for a stock ticker using TradeScanner.',
  { ticker: z.string().describe('Stock ticker symbol, e.g. AAPL, PLUG, TSLA') },
  async ({ ticker }) => {
    const res = await fetch(`${BASE_URL}/price?ticker=${encodeURIComponent(ticker)}`, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(data, null, 2),
      }],
    };
  }
);

server.tool(
  'strike_sense_check',
  'Check whether a given options strike price is realistic for a stock. Returns a PASS, CAUTION, or REJECTED verdict with a plain-English reason.',
  {
    ticker: z.string().describe('Stock ticker symbol, e.g. AAPL'),
    strike: z.number().describe('The strike price to evaluate'),
  },
  async ({ ticker, strike }) => {
    const res = await fetch(`${BASE_URL}/api/strike-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify({ ticker, strike }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(data, null, 2),
      }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(err.message + '\n');
  process.exit(1);
});
