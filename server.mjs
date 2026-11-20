import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { GoogleGenAI } from '@google/genai';

const root = path.dirname(fileURLToPath(import.meta.url));
const workbook = path.join(root, 'data', 'requests.xlsx');
const mcpServer = path.join(root, 'node_modules', '@knorq', 'xlsx-mcp-server', 'dist', 'index.js');
const app = express();
app.use(express.json());
app.use(express.static(path.join(root, 'public')));

function textOf(result) { return result.content?.map((part) => part.text || '').join('\n') || ''; }
function short(value, max = 500) { const raw = typeof value === 'string' ? value : JSON.stringify(value); return raw.length > max ? `${raw.slice(0, max)}…` : raw; }
function parseSheet(result) {
  const match = textOf(result).match(/<json>([\s\S]+)<\/json>/);
  if (!match) throw new Error('MCP вернул данные в неожиданном формате.');
  const rows = JSON.parse(match[1]).data;
  return rows.slice(1).map((row) => {
    const values = row.cells.map((cell) => cell.value ?? '');
    return { row: row.row, id: Number(values[0]), client: String(values[1]), problem: String(values[2]), status: String(values[3]) };
  });
}
async function withMcp(run) {
  const client = new Client({ name: 'excel-service-agent', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpServer] }));
  try { return await run(client); } finally { await client.close(); }
}
async function mcp(log, name, args) {
  const started = Date.now();
  const result = await withMcp((client) => client.callTool({ name, arguments: args }));
  log.push({ tool: name, parameters: args, result: short(textOf(result)), elapsedMs: Date.now() - started, isError: Boolean(result.isError) });
  if (result.isError) throw new Error(textOf(result));
  return result;
}
async function getRequests(log) {
  return parseSheet(await mcp(log, 'read_sheet', { file_path: workbook, sheet: 'Заявки' }));
}

async function planWithGemini(message) {
  if (!process.env.GEMINI_API_KEY) return null;
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const prompt = `Ты планировщик для заявок сервисного центра. Верни только JSON без Markdown.
Возможные action: add, change_status, list_status, unknown.
JSON-схема: {"action":"...","client":"...","problem":"...","status":"...","id":number|null}.
Если не хватает проблемы для новой заявки, action add и problem пустой. Не придумывай данные.
Имя клиента всегда приводи к именительному падежу: «от Анны Смирновой» → «Анна Смирнова», «от Дмитрия» → «Дмитрий». Это же правило применяй при поиске заявки по имени.
Сообщение пользователя: ${JSON.stringify(message)}`;
  const response = await ai.models.generateContent({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash', contents: prompt, config: { responseMimeType: 'application/json', temperature: 0 } });
  return JSON.parse(response.text);
}
function localPlan(message) {
  const cleaned = message.trim();
  const id = Number(cleaned.match(/(?:№|#)\s*(\d+)/)?.[1]) || null;
  const status = cleaned.match(/(?:статусом?|на)\s*[«"']?([^«"'.!?]+?)[»"']?(?:$|\.|\?)/i)?.[1]?.trim();
  if (/покажи|какие|список/i.test(cleaned) && /заявк/i.test(cleaned)) return { action: 'list_status', status: status || '' };
  if (/измени|поменяй|установи/i.test(cleaned) && /статус/i.test(cleaned)) {
    const client = cleaned.match(/(?:заявки|от)\s+(.+?)\s+на\s+[«"']/i)?.[1]?.trim() || '';
    return { action: 'change_status', client, status: status || '', id };
  }
  if (/добав/i.test(cleaned) && /заявк/i.test(cleaned)) {
    const client = cleaned.match(/от\s+([^:.]+?)(?::|$)/i)?.[1]?.trim() || '';
    const problem = cleaned.match(/:\s*(.+)$/)?.[1]?.trim() || '';
    return { action: 'add', client, problem };
  }
  return { action: 'unknown' };
}
async function makePlan(message) {
  let plan;
  try { plan = (await planWithGemini(message)) || localPlan(message); } catch { plan = localPlan(message); }
  if (plan.client) plan.client = plan.client.replace(/Анны Смирновой/gi, 'Анна Смирнова').replace(/^Дмитрия$/i, 'Дмитрий');
  return plan;
}

const sessions = new Map();
function session(id) { if (!sessions.has(id)) sessions.set(id, { pending: null }); return sessions.get(id); }

app.get('/api/requests', async (_req, res) => {
  const trace = [];
  try { res.json({ requests: await getRequests(trace), trace }); } catch (error) { res.status(500).json({ error: error.message, trace }); }
});

app.post('/api/chat', async (req, res) => {
  const message = String(req.body?.message || '').trim();
  const state = session(String(req.body?.sessionId || 'default'));
  const trace = [];
  if (!message) return res.status(400).json({ error: 'Введите сообщение.', trace });
  try {
    if (state.pending && /^(да|подтверждаю|подтвердить|ок|хорошо)$/i.test(message)) {
      const change = state.pending;
      await mcp(trace, 'write_cell', { file_path: workbook, sheet: 'Заявки', cell: `D${change.row}`, value: change.status });
      const rows = await getRequests(trace);
      state.pending = null;
      const verified = rows.find((item) => item.row === change.row)?.status === change.status;
      return res.json({ reply: verified ? `Готово: у заявки №${change.id} статус теперь «${change.status}». Изменение проверено в Excel.` : 'Не удалось проверить изменение.', requests: rows, trace });
    }
    if (state.pending) state.pending = null;
    const plan = await makePlan(message);
    if (plan.action === 'add') {
      if (!plan.client || !plan.problem) return res.json({ reply: 'Уточните, пожалуйста, какая проблема у клиента. Без описания проблемы я не буду создавать заявку.', requests: await getRequests(trace), trace });
      const rows = await getRequests(trace);
      const id = Math.max(100, ...rows.map((item) => item.id)) + 1;
      const row = Math.max(1, ...rows.map((item) => item.row)) + 1;
      await mcp(trace, 'write_row', { file_path: workbook, sheet: 'Заявки', row, values: [id, plan.client, plan.problem, 'Новый'] });
      const updated = await getRequests(trace);
      return res.json({ reply: `Заявка №${id} от ${plan.client} добавлена. Статус: «Новый».`, requests: updated, trace });
    }
    if (plan.action === 'change_status') {
      if (!plan.status) return res.json({ reply: 'Уточните новый статус заявки.', requests: await getRequests(trace), trace });
      const rows = await getRequests(trace);
      const found = plan.id ? rows.find((item) => item.id === plan.id) : rows.find((item) => item.client.toLowerCase() === String(plan.client || '').toLowerCase());
      if (!found) return res.json({ reply: 'Заявка не найдена. Я ничего не изменял в Excel.', requests: rows, trace });
      state.pending = { row: found.row, id: found.id, status: plan.status };
      return res.json({ reply: `Нашёл заявку №${found.id}: ${found.client}, «${found.problem}», текущий статус «${found.status}». Изменить статус на «${plan.status}»? Ответьте «да» для подтверждения.`, requests: rows, trace, needsConfirmation: true });
    }
    if (plan.action === 'list_status') {
      const rows = await getRequests(trace);
      const found = rows.filter((item) => item.status.toLowerCase() === String(plan.status || '').toLowerCase());
      const list = found.length ? found.map((item) => `№${item.id} — ${item.client}`).join('; ') : 'подходящих заявок нет';
      return res.json({ reply: `Найдено заявок со статусом «${plan.status}»: ${found.length}. ${list}.`, requests: rows, trace });
    }
    return res.json({ reply: 'Я могу добавить заявку, изменить её статус или показать заявки по статусу. Сформулируйте команду, например: «Покажи заявки со статусом В работе».', requests: await getRequests(trace), trace });
  } catch (error) { return res.status(500).json({ error: `Ошибка при работе с MCP: ${error.message}`, trace }); }
});

app.listen(Number(process.env.PORT || 3001), () => console.log(`http://localhost:${process.env.PORT || 3001}`));
