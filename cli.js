// cli.js — CLI con soporte MCP STDIO (:tools y :call)
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createNodeCore } = require('./core.js'); // tu core UMD exporta createNodeCore
const { createStdIoClient } = require('./mcp-stdio'); // NUEVO

// ---- Carga servers.json ----
const SERVERS_PATH = path.join(__dirname, 'servers.json');
const servers = JSON.parse(fs.readFileSync(SERVERS_PATH, 'utf8'));

let current = servers[0];
const stdioClients = new Map();

// ---- Core (para mock/LLM y sesiones/logs) ----
const core = createNodeCore({ sessionsDir: 'sessions', serversFile: 'servers.json' });

// ---- Util ----
function printHelp(){
  console.log(`
Comandos:
  :help                 Mostrar ayuda
  :servers              Listar servidores
  :use <id>             Seleccionar servidor activo
  :send <texto>         Enviar mensaje (mock JSON-RPC)  [solo servers mock]
  :logs                 Ver logs de esta sesión CLI
  :reset                Reiniciar sesión del servidor activo
  :export [ruta]        Exportar sesión actual a JSON (ruta opcional)
  :status               Ver contexto que se enviaría

  (MCP STDIO)
  :tools                tools/list al server activo (stdio)
  :call <tool> <json>   tools/call con params JSON (stdio)

  :quit / :exit         Salir
  (Tip) Texto directo = enviar (mock)
`);
}

function listServers(){
  console.log('\nServidores disponibles:');
  for (const s of servers) {
    const mark = s.id === current.id ? '*' : ' ';
    console.log(` ${mark} ${s.id.padEnd(6)} -  ${s.label}${s.transport ? ` [${s.transport}]` : ''}`);
  }
  console.log('');
}

async function ensureMcpFor(server){
  if (server.transport !== 'stdio') return null;
  if (stdioClients.has(server.id)) return stdioClients.get(server.id);
  const client = createStdIoClient({ cmd: server.cmd, args: server.args, cwd: process.cwd() });
  await client.initialize();
  stdioClients.set(server.id, client);
  return client;
}

async function switchServer(id){
  const s = servers.find(x=>x.id === id);
  if (!s) { console.log('No existe server:', id); return; }
  current = s;
  console.log(`[server] ${current.id} -> ${current.label}`);
  if (current.transport === 'stdio') {
    await ensureMcpFor(current);
  }
}

function showStatus(){
  const sess = core.sessions[current.id] || { messages: [], createdAt: Date.now() };
  const ctx = core.buildContext(current.id);
  console.log('\n→ Contexto (previo a enviar):');
  console.log(JSON.stringify(ctx, null, 2));
  console.log('\nResumen sesión:');
  console.log(`- mensajes: ${sess.messages.length}`);
  console.log(`- createdAt: ${new Date(sess.createdAt).toISOString()}\n`);
}

// ---- Boot ----
(async function boot(){
  await core.boot();
  current = core.current; // arranca con el primero de servers.json
  console.log(`[${new Date().toISOString()}] server:init -> ${current.id}\n`);
  printHelp();
  listServers();
})();

// ---- CLI loop ----
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'mcp> ' });
rl.prompt();

rl.on('line', async (line)=>{
  const txt = line.trim();
  if (!txt) return rl.prompt();

  // comandos
  if (txt === ':help') { printHelp(); return rl.prompt(); }
  if (txt === ':servers') { listServers(); return rl.prompt(); }
  if (txt.startsWith(':use ')) { await switchServer(txt.split(' ')[1]); return rl.prompt(); }
  if (txt === ':logs') { console.log(core.logs.join('\n')); return rl.prompt(); }
  if (txt === ':reset') { core.resetSession(current.id); console.log('OK'); return rl.prompt(); }
  if (txt.startsWith(':export')) {
    const out = txt.split(' ')[1];
    const p = core.exportSession(current.id, out);
    console.log('Export:', p);
    return rl.prompt();
  }
  if (txt === ':status') { showStatus(); return rl.prompt(); }

  // MCP STDIO
  if (txt === ':tools') {
    if (current.transport !== 'stdio') { console.log('El server activo no es stdio/MCP.'); return rl.prompt(); }
    try {
      const c = await ensureMcpFor(current);
      const res = await c.toolsList();
      console.log(JSON.stringify(res, null, 2));
    } catch(e){ console.log('Error tools/list:', String(e.message||e)); }
    return rl.prompt();
  }

  if (txt.startsWith(':call ')) {
    if (current.transport !== 'stdio') { console.log('El server activo no es stdio/MCP.'); return rl.prompt(); }
    const rest = txt.slice(6).trim();
    const spaceIdx = rest.indexOf(' ');
    const tool = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    const json = spaceIdx === -1 ? '{}' : rest.slice(spaceIdx+1);
    try {
      let params = {};
      if (json) params = JSON.parse(json);
      const c = await ensureMcpFor(current);
      const res = await c.toolsCall(tool, params);
      console.log(JSON.stringify(res, null, 2));
    } catch(e){ console.log('Error tools/call:', String(e.message||e)); }
    return rl.prompt();
  }

  // Texto directo = enviar (mock)
  if (txt === ':quit' || txt === ':exit') { process.exit(0); }

  // Por defecto, usa mock local (solo para servers mock)
  if (!current.transport) {
    core.sendMock(txt);
    console.log('\n→ Request (Anfitrión)\n', JSON.stringify({ echo: txt }, null, 2));
    console.log('\n← Response (Servidor)\n', '(mock) Entendido');
  } else {
    console.log('Este comando de texto directo aplica solo a servidores mock. Usa :tools / :call en MCP.');
  }
  rl.prompt();
});

rl.on('close', ()=> process.exit(0));