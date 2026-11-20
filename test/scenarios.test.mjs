import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filePath = path.join(root, 'data', 'requests.xlsx');
const serverPath = path.join(root, 'node_modules', '@knorq', 'xlsx-mcp-server', 'dist', 'index.js');
function json(result) { return JSON.parse(result.content[0].text.match(/<json>([\s\S]+)<\/json>/)[1]); }
async function connected(run) {
  const client = new Client({ name: 'verification', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
  try { return await run(client); } finally { await client.close(); }
}

test('готовый Excel MCP создаёт, читает, добавляет и меняет данные', async () => {
  execFileSync(process.execPath, ['seed.mjs'], { cwd: root, stdio: 'inherit' });
  await connected(async (client) => {
    const first = json(await client.callTool({ name: 'read_sheet', arguments: { file_path: filePath, sheet: 'Заявки' } }));
    assert.equal(first.totalRows, 4);
    await client.callTool({ name: 'write_row', arguments: { file_path: filePath, sheet: 'Заявки', row: 5, values: [104, 'Анна Смирнова', 'Ноутбук сильно тормозит', 'Новый'] } });
    await client.callTool({ name: 'write_cell', arguments: { file_path: filePath, sheet: 'Заявки', cell: 'D5', value: 'В работе' } });
    const changed = json(await client.callTool({ name: 'read_sheet', arguments: { file_path: filePath, sheet: 'Заявки' } }));
    const anna = changed.data.at(-1).cells.map((cell) => cell.value);
    assert.deepEqual(anna, [104, 'Анна Смирнова', 'Ноутбук сильно тормозит', 'В работе']);
  });
});
