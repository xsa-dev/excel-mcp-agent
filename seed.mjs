import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.join(root, 'data', 'requests.xlsx');
const serverPath = path.join(root, 'node_modules', '@knorq', 'xlsx-mcp-server', 'dist', 'index.js');
const client = new Client({ name: 'excel-service-agent-seeder', version: '1.0.0' });

await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath] }));
try {
  await client.callTool({ name: 'create_workbook', arguments: { file_path: filePath, sheet_name: 'Заявки' } });
  await client.callTool({ name: 'clear_cells', arguments: { file_path: filePath, sheet: 'Заявки', range: 'A1:D10000' } });
  await client.callTool({ name: 'write_rows', arguments: {
    file_path: filePath,
    sheet: 'Заявки',
    start_row: 1,
    rows: [
      ['ID', 'Клиент', 'Проблема', 'Статус'],
      [101, 'Иван Петров', 'Ноутбук не включается', 'Новый'],
      [102, 'Мария Соколова', 'Принтер не печатает', 'В работе'],
      [103, 'Олег Иванов', 'Мерцает монитор', 'Готово']
    ]
  } });
  console.log(`Создан ${filePath} через MCP.`);
} finally {
  await client.close();
}
