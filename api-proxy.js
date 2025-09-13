// api-proxy.js — Proxy LLM (Groq) + MCP bridge (stdio y http) con memoria ligera y normalización FS
'use strict';
require('dotenv').config();

const http  = require('http');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');

// ================= Config =================
const PORT = parseInt(process.env.PORT || '8787', 10);

// LLM: Groq
const GROQ_API_KEY     = process.env.GROQ_API_KEY || '';
const GROQ_MODEL       = process.env.GROQ_MODEL   || 'llama-3.1-8b-instant';
const GROQ_MAX_TOKENS  = parseInt(process.env.GROQ_MAX_TOKENS || '256', 10);
const GROQ_TEMPERATURE = Number(process.env.GROQ_TEMPERATURE || '0.2');

// ================= Memoria ligera =================
const mem = {
  lastUserText: '',
  FS: { last_dir: '' },   // mantengo el campo, pero ya no lo impongo salvo "."
  chat: []                // historial chat (user/assistant)
};
const CHAT_MAX_MESSAGES = 12;
const CHAT_MAX_CHARS    = 6000;

// ================= Utils =================
function sendJSON(res, code, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-auth-token',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}
function notFound(res){ sendJSON(res, 404, { error: 'Not found' }); }
function readBody(req){
  return new Promise((resolve,reject)=>{
    let b=''; req.on('data',d=> b+=d);
    req.on('end',()=> resolve(b)); req.on('error',reject);
  });
}
function sleep(ms){ return new Promise(r=> setTimeout(r, ms)); }

// ===== Normalización de paths de FS (clave para “raíz” del MCP) =====
function normalizeMcpPath(p) {
  if (p == null) return p;
  let s = String(p).trim();
  // Tratar "/foo" o "./foo" como "foo" (raíz del servidor MCP)
  s = s.replace(/^\/+/, '').replace(/^\.\/+/, '');
  if (s.startsWith('~/')) s = s.slice(2);       // no hay home en sandbox MCP
  s = s.replace(/\\/g, '/');                    // barras Windows -> POSIX
  s = s.replace(/\/{2,}/g, '/');                // colapsar dobles
  return s;
}
function normalizeFsArgs(args) {
  const out = { ...(args || {}) };
  if ('path' in out) out.path = normalizeMcpPath(out.path);
  if ('source' in out) out.source = normalizeMcpPath(out.source);
  if ('destination' in out) out.destination = normalizeMcpPath(out.destination);
  if ('dir' in out) out.dir = normalizeMcpPath(out.dir);
  if ('patternDir' in out) out.patternDir = normalizeMcpPath(out.patternDir);
  if (Array.isArray(out.files)) out.files = out.files.map(normalizeMcpPath);
  if (Array.isArray(out.paths)) out.paths = out.paths.map(normalizeMcpPath);
  return out;
}
// Heurística: nombres de tools de FS a ajustar
function looksFsTool(name='') {
  const prefix = name.split('_')[0] || '';
  return /^(read|write|create|delete|move|copy|list|search|directory)/i.test(prefix) ||
         /(file|directory|path|mkdir)/i.test(name);
}

// ================= servers.json =================
function readServersConfig() {
  const file = path.join(process.cwd(), 'servers.json');
  if (fs.existsSync(file)) {
    try {
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(arr)) return arr;
    } catch {}
  }
  return [
    {
      id: 'fs',
      label: 'Filesystem (MCP, stdio)',
      transport: 'stdio',
      cmd: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.']
    }
  ];
}
const serversConfig = readServersConfig();

function getServerUrl(id){
  const cfg = serversConfig.find(s => s.id === id);
  if (!cfg || cfg.transport !== 'http' || !cfg.url) throw new Error(`server '${id}' no es http o no tiene url`);
  return cfg.url.replace(/\/+$/,'');
}
function getDefaultRepoPathFromConfig(id = 'git'){
  const cfg = serversConfig.find(s => s.id === id);
  if (!cfg) return null;
  const args = cfg.args || [];
  const i = args.indexOf('--repository');
  if (i >= 0 && args[i+1]) return String(args[i+1]);
  const j = args.indexOf('--repo');
  if (j >= 0 && args[j+1]) return String(args[j+1]);
  return null;
}

// ================= MCP bridges (STDIO) =================
const mcpProcs  = new Map(); // id -> {proc, buf, nextId, pending, ready, rpc, notify, init}
const mcpStates = new Map(); // id -> {id,label,transport,status}

const CLIENT_INFO = { name: 'P1-Anfitrion', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

function ensureServerState(id) {
  if (!mcpStates.has(id)) {
    const cfg = serversConfig.find(s=>s.id===id);
    mcpStates.set(id, {
      id,
      label: cfg?.label || id,
      transport: cfg?.transport || 'stdio',
      status: 'stopped'
    });
  }
  return mcpStates.get(id);
}

function spawnMcp(id) {
  const cfg = serversConfig.find(s=> s.id === id);
  const state = ensureServerState(id);
  if (!cfg) throw new Error(`No hay config para server '${id}'`);
  if (cfg.transport !== 'stdio') throw new Error(`Solo transport=stdio soportado (id=${id})`);
  if (mcpProcs.has(id)) return mcpProcs.get(id);

  console.log(`[mcp:${id}] spawn:`, cfg.cmd, (cfg.args||[]).join(' '), 'cwd=', process.cwd());
  const child = spawn(cfg.cmd, cfg.args || [], { stdio: ['pipe','pipe','pipe'] });
  const obj = { proc: child, buf: '', nextId: 1, pending: new Map(), ready: false };

  child.stdout.on('data', (chunk)=>{
    obj.buf += chunk.toString();
    let idx;
    while ((idx = obj.buf.indexOf('\n')) >= 0) {
      const line = obj.buf.slice(0, idx).trim();
      obj.buf = obj.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && obj.pending.has(msg.id)) {
          const { resolve, reject } = obj.pending.get(msg.id);
          obj.pending.delete(msg.id);
          if (msg.error) reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)));
          else resolve(msg.result ?? msg);
        }
      } catch {
        console.error(`[mcp:${id}] stdout(non-json):`, line);
      }
    }
  });
  child.stderr.on('data', (d)=>{
    const s = d.toString();
    if (s.trim()) console.error(`[mcp:${id}] STDERR: ${s.trim()}`);
  });
  child.on('exit', (code, signal)=>{
    state.status = 'stopped';
    console.error(`[mcp:${id}] EXIT code=${code} signal=${signal ?? 'none'}`);
    for (const {reject} of obj.pending.values()) {
      reject(new Error(`Proceso MCP '${id}' salió con código ${code}`));
    }
    mcpProcs.delete(id);
  });

  obj.rpc = (method, params={})=>{
    const idNum = obj.nextId++;
    const req = { jsonrpc:'2.0', id: idNum, method, params };
    return new Promise((resolve, reject)=>{
      obj.pending.set(idNum, { resolve, reject });
      child.stdin.write(JSON.stringify(req) + '\n');
      setTimeout(()=>{
        if (obj.pending.has(idNum)) {
          obj.pending.delete(idNum);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 15000);
    });
  };
  obj.notify = (method, params = {}) => {
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch (_) {}
  };

  const init = async ()=>{
    try{
      await obj.rpc('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: CLIENT_INFO,
        capabilities: { experimental: {} }
      });
      obj.notify('initialized', {});
      obj.notify('notifications/initialized', {}); // compat
      await sleep(800);
      state.status = 'ready';
      obj.ready = true;
    }catch(e){
      state.status = 'error';
      throw e;
    }
  };

  mcpProcs.set(id, obj);
  state.status = 'starting';
  return { ...obj, init: ()=> init() };
}

// Retry/backoff
async function rpcWithInitRetry(p, method, params = {}, tries = 6) {
  let attempt = 0;
  let delay = 250;
  while (true) {
    try {
      return await p.rpc(method, params);
    } catch (e) {
      const msg = String(e?.message || e);
      const notReady = /before initialization was complete/i.test(msg);
      const invalid  = /-32602/.test(msg);
      if (!(notReady || invalid) || attempt >= (tries - 1)) throw e;
      await sleep(delay);
      delay = Math.min(delay * 2, 1500);
      attempt++;
    }
  }
}

let lastToolsVariant = null;

async function getTools(id){
  const p = mcpProcs.get(id) || spawnMcp(id);
  if (!p.ready) await p.init?.();

  try {
    lastToolsVariant = 'tools/list {}';
    return await rpcWithInitRetry(p, 'tools/list', {});
  } catch (e1) {
    try {
      lastToolsVariant = 'tools/list (no params)';
      return await rpcWithInitRetry(p, 'tools/list');
    } catch (e2) {
      try {
        lastToolsVariant = 'tools/list {limit:200}';
        return await rpcWithInitRetry(p, 'tools/list', { limit: 200 });
      } catch (e3) {
        lastToolsVariant = 'tools/list {cursor:""}';
        return await rpcWithInitRetry(p, 'tools/list', { cursor: "" });
      }
    }
  }
}

async function callToolStdIO(id, name, args){
  const p = mcpProcs.get(id) || spawnMcp(id);
  if (!p.ready) await p.init?.();

  // git_* -> repo_path por defecto si falta
  if (name && name.startsWith('git_') && (args && !args.repo_path)) {
    const repo = getDefaultRepoPathFromConfig(id) || getDefaultRepoPathFromConfig('git');
    if (repo) args.repo_path = repo;
  }
  // FS -> normalizar
  if (looksFsTool(name)) {
    args = normalizeFsArgs(args || {});
  }

  return rpcWithInitRetry(p, 'tools/call', { name, arguments: args || {} });
}

// ================= LLM: Groq =================
async function handleLLM(bodyRaw) {
  if (!GROQ_API_KEY) throw new Error('Groq no configurado (GROQ_API_KEY)');
  let payload;
  try { payload = JSON.parse(bodyRaw || '{}'); } catch { throw new Error('Bad JSON'); }
  const userPrompt = String(payload?.prompt || '');
  const extraContext = Array.isArray(payload?.context) ? payload.context : [];

  mem.lastUserText = userPrompt;

  const baseSystem = [
    'Eres un asistente breve y claro.',
    mem.FS.last_dir ? `Contexto: FS.last_dir=${mem.FS.last_dir}` : ''
  ].filter(Boolean).join('\n');

  // recorte historial
  let hist = mem.chat.slice(-CHAT_MAX_MESSAGES);
  let charCount = hist.reduce((n, m) => n + m.content.length, 0);
  while (charCount > CHAT_MAX_CHARS && hist.length > 2) {
    hist = hist.slice(2);
    charCount = hist.reduce((n, m) => n + m.content.length, 0);
  }

  const messages = [
    { role: 'system', content: baseSystem },
    ...hist,
    ...extraContext.map(m => ({ role: m.role === 'server' ? 'assistant' : 'user', content: String(m.content || '') })),
    { role: 'user', content: userPrompt }
  ];

  const reqBodyBase = {
    model: GROQ_MODEL,
    messages,
    stream: false,
    max_tokens: GROQ_MAX_TOKENS,
    temperature: GROQ_TEMPERATURE
  };

  const doFetch = async (override = {}) => {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${GROQ_API_KEY}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ ...reqBodyBase, ...override })
    });
    const txt = await r.text();
    if (!r.ok) {
      const err = new Error(`Groq HTTP ${r.status}`);
      err.status = r.status;
      err.details = txt;
      err.retryAfter =
        r.headers.get('retry-after') ||
        (txt.match(/try again in ([0-9.]+)s/i)?.[1] ? Math.ceil(parseFloat(txt.match(/try again in ([0-9.]+)s/i)[1])) : null);
      throw err;
    }
    return JSON.parse(txt);
  };

  let data;
  try {
    data = await doFetch();
  } catch (e) {
    if (e.status === 429 || e.status === 503) {
      const waitMs = Math.min((Number(e.retryAfter || 2) * 1000), 8000);
      await new Promise(r => setTimeout(r, waitMs));
      data = await doFetch({ max_tokens: Math.max(128, Math.floor(GROQ_MAX_TOKENS * 0.5)) });
    } else {
      throw e;
    }
  }

  const reply = data.choices?.[0]?.message?.content || '';
  const usage = data.usage || null;

  // persistir historial
  mem.chat.push({ role: 'user', content: userPrompt });
  mem.chat.push({ role: 'assistant', content: reply });
  if (mem.chat.length > CHAT_MAX_MESSAGES) mem.chat = mem.chat.slice(-CHAT_MAX_MESSAGES);
  let totalChars = mem.chat.reduce((n, m) => n + m.content.length, 0);
  while (totalChars > CHAT_MAX_CHARS && mem.chat.length > 2) {
    mem.chat = mem.chat.slice(2);
    totalChars = mem.chat.reduce((n, m) => n + m.content.length, 0);
  }

  return { reply, tokens: usage, model: GROQ_MODEL };
}

// ================= HTTP Server =================
const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url, true);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type,x-auth-token',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    });
    return res.end();
  }

  try {
    // ---------- LLM ----------
    if (req.method === 'POST' && pathname === '/api/llm') {
      const body = await readBody(req);
      try {
        const out = await handleLLM(body);
        return sendJSON(res, 200, out);
      } catch (e) {
        const details = e.details || String(e.message || e);
        return sendJSON(res, 503, { error: 'Groq proxy error', details });
      }
    }

    // ---------- Limpiar memoria de chat ----------
    if (req.method === 'GET' && pathname === '/api/memory/clear') {
      mem.chat = [];
      return sendJSON(res, 200, { ok: true, cleared: true });
    }

    // ---------- Inventario de servidores ----------
    if (req.method === 'GET' && pathname === '/api/mcp/servers') {
      const list = serversConfig.map(cfg=>{
        const st = ensureServerState(cfg.id);
        return {
          id: cfg.id,
          label: cfg.label || cfg.id,
          transport: cfg.transport || 'stdio',
          status: st.status,
          url: cfg.url || undefined
        };
      });
      return sendJSON(res, 200, { servers: list });
    }

    // ---------- tools/list ----------
    if (req.method === 'POST' && /^\/api\/mcp\/[^/]+\/tools$/.test(pathname)) {
      const id = pathname.split('/')[3];
      const cfg = serversConfig.find(s => s.id === id);
      if (!cfg) return sendJSON(res, 404, { error: 'server not found' });

      if (cfg.transport === 'http' && cfg.url) {
        try {
          const r = await fetch(new URL('/tools', cfg.url).toString(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
          });
          const txt = await r.text();
          if (!r.ok) return sendJSON(res, 500, { error: 'tools/list failed', details: txt, variant: 'remote-http {}' });
          return sendJSON(res, 200, JSON.parse(txt));
        } catch (e) {
          return sendJSON(res, 500, { error: 'tools/list failed', details: String(e.message||e), variant: 'remote-http {}' });
        }
      }

      try {
        const result = await getTools(id);
        return sendJSON(res, 200, result);
      } catch (e) {
        return sendJSON(res, 500, { error: 'tools/list failed', details: String(e.message || e), variant: lastToolsVariant });
      }
    }

    // ---------- tools/call ----------
    if (req.method === 'POST' && /^\/api\/mcp\/[^/]+\/call$/.test(pathname)) {
      const id = pathname.split('/')[3];
      const body = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch {}
      const { name } = payload || {};
      let args = (payload && payload.arguments) ? { ...payload.arguments } : {};
      if (!name) return sendJSON(res, 400, { error: 'missing name' });

      const cfg = serversConfig.find(s => s.id === id);
      if (!cfg) return sendJSON(res, 404, { error: 'server not found' });

      // ======== Reglas de argumentos antes de reenviar ========
      // (1) FS: normalización SIEMPRE. NO concatenar last_dir, salvo path="."
      if (looksFsTool(name)) {
        args = normalizeFsArgs(args);
        if (args && typeof args.path === 'string') {
          const p = args.path.trim();
          if (p === '.' || p === './') {
            // Solo si el usuario dijo explícitamente "." usamos last_dir
            if (mem.FS.last_dir) {
              args.path = normalizeMcpPath(mem.FS.last_dir);
            } else {
              args.path = ''; // raíz
            }
          }
        }
      }

      // (2) git_* -> repo_path por defecto
      if (name.startsWith('git_') && !args.repo_path) {
        const repo = getDefaultRepoPathFromConfig(id) || getDefaultRepoPathFromConfig('git');
        if (repo) args.repo_path = repo;
      }

      // === HTTP remoto
      if (cfg.transport === 'http' && cfg.url) {
        try {
          const r = await fetch(new URL('/call', cfg.url).toString(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, arguments: args || {} })
          });
          const txt = await r.text();
          if (!r.ok) return sendJSON(res, 500, { error: 'tools/call failed', details: txt });

          // Actualiza last_dir solo si tuvo éxito y aplica
          try {
            if (args && typeof args.path === 'string' &&
               (name.includes('write') || name.includes('create') || name.includes('mkdir'))) {
              const dir = path.posix.dirname(args.path);
              if (dir && dir !== '.' && dir !== '/') mem.FS.last_dir = dir;
            }
          } catch (_e) {}

          return sendJSON(res, 200, JSON.parse(txt));
        } catch (e) {
          return sendJSON(res, 500, { error: 'tools/call failed', details: String(e.message||e) });
        }
      }

      // === STDIO
      try {
        const result = await callToolStdIO(id, name, args || {});
        try {
          if (args && typeof args.path === 'string' &&
              (name.includes('write') || name.includes('create') || name.includes('mkdir'))) {
            const dir = path.posix.dirname(args.path);
            if (dir && dir !== '.' && dir !== '/') mem.FS.last_dir = dir;
          }
        } catch (_e) {}
        return sendJSON(res, 200, result);
      } catch (e) {
        return sendJSON(res, 500, { error: 'tools/call failed', details: String(e.message || e) });
      }
    }

    // ---------- raíz ----------
    if (req.method === 'GET' && pathname === '/') {
      return sendJSON(res, 200, {
        ok: true,
        llm: { provider: 'groq', model: GROQ_MODEL, max_tokens: GROQ_MAX_TOKENS, temperature: GROQ_TEMPERATURE },
        endpoints: {
          llm: 'POST /api/llm',
          memory_clear: 'GET /api/memory/clear',
          mcp: ['GET /api/mcp/servers','POST /api/mcp/:id/tools','POST /api/mcp/:id/call']
        },
        protocolVersion: PROTOCOL_VERSION
      });
    }

    notFound(res);
  } catch (e) {
    sendJSON(res, 500, { error: 'proxy crash', details: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`Proxy listo en http://localhost:${PORT}/`);
  console.log(`  - LLM   : POST /api/llm  (Groq, model=${GROQ_MODEL}, max_tokens=${GROQ_MAX_TOKENS}, temp=${GROQ_TEMPERATURE})`);
  console.log(`  - MCP   : GET  /api/mcp/servers`);
  console.log(`            POST /api/mcp/:id/tools`);
  console.log(`            POST /api/mcp/:id/call`);
  console.log(`  - MCP STDIO protocolVersion=${PROTOCOL_VERSION}`);
  console.log('Hit CTRL-C to stop the server');
});