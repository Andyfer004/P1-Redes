// app.js — Asistente LLM+MCP con fast-path, atajos FS/Git y soporte natural para git push
(function(){
  const $ = (id)=> document.getElementById(id);
  const serverSelect = $('serverSelect');
  const btnNew = $('btnNew');
  const btnExport = $('btnExport');
  const msg = $('msg');
  const btnSend = $('btnSend');
  const io = $('io');
  const logBox = $('log');
  const ctxInfo = $('ctxInfo');

  // ================= Captura de errores globales =================
  window.onerror = function(message, source, lineno, colno, error) {
    setIO(`⚠️ JS Error\n${message}\n${source}:${lineno}:${colno}\n${error && (error.stack || error)}`);
    return false;
  };
  window.onunhandledrejection = function(ev){
    setIO(`⚠️ Unhandled Promise Rejection\n${String(ev.reason || ev)}`);
  };

  const setIO = (t)=> { io.textContent = t; };
  const uiLog = (line)=>{
    const div = document.createElement('div');
    div.textContent = line;
    logBox.prepend(div);
  };

  // ================= Utils HTTP =================
  async function fetchJSON(url, opts = {}, timeoutMs = 15000){
    const ctrl = new AbortController();
    const to = setTimeout(()=> ctrl.abort(), timeoutMs);
    try{
      const r = await fetch(url, { headers: {'content-type': 'application/json'}, signal: ctrl.signal, ...opts });
      const txt = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt}`);
      try { return JSON.parse(txt); } catch { return txt; }
    } finally { clearTimeout(to); }
  }
  async function llmDirect(prompt, context=[]){
    uiLog('POST /api/llm (direct)');
    return fetchJSON('http://localhost:8787/api/llm', {
      method: 'POST', body: JSON.stringify({ prompt, context })
    });
  }

  // --- Normalizador de rutas MCP: trata "/" como relativo a la raíz del servidor ---
function normalizeMcpPath(p) {
  if (p == null) return p;
  let s = String(p).trim();
  // "/foo" -> "foo" (raíz MCP), "./foo" -> "foo"
  s = s.replace(/^\/+/, '').replace(/^\.\/+/, '');
  // "~/" no aplica en sandbox MCP
  if (s.startsWith('~/')) s = s.slice(2);
  // limpia dobles barras
  s = s.replace(/\/{2,}/g, '/');
  return s;
}

// Normaliza campos comunes de tools de FS
function normalizeFsArgs(args) {
  const out = { ...(args || {}) };

  // claves frecuentes
  if ('path' in out) out.path = normalizeMcpPath(out.path);
  if ('source' in out) out.source = normalizeMcpPath(out.source);
  if ('destination' in out) out.destination = normalizeMcpPath(out.destination);
  if ('dir' in out) out.dir = normalizeMcpPath(out.dir);
  if ('patternDir' in out) out.patternDir = normalizeMcpPath(out.patternDir);

  // listas de archivos
  if (Array.isArray(out.files)) out.files = out.files.map(normalizeMcpPath);
  if (Array.isArray(out.paths)) out.paths = out.paths.map(normalizeMcpPath);

  return out;
}

// Conjunto de tools de FS a normalizar automáticamente
const FS_TOOL_PREFIXES = new Set([
  'read_', 'write_', 'create_', 'delete_', 'move_', 'copy_', 'list_', 'search_', 'directory_'
]);


  // ================= Estado core =================
  let core = null;
  let coreReady = false;
  const toolsCache = new Map(); // serverId -> [{name, description}]

  function renderServers(){
    if (!coreReady) return;
    serverSelect.innerHTML = '';
    core.servers.forEach(s=>{
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.id} — ${s.label}${s.transport?` [${s.transport}]`:''}`;
      if (core.current && core.current.id === s.id) opt.selected = true;
      serverSelect.appendChild(opt);
    });
  }
  function updateCtxInfo(){
    ctxInfo.textContent = coreReady ? `ctx: ${core.getContextTurns()} turns` : 'ctx: -';
  }

  async function ensureTools(serverId){
    if (!coreReady || !serverId) return [];
    const srv = core.servers.find(s=> s.id === serverId);
    if (!srv) return [];
    if (!(srv.transport === 'stdio' || srv.transport === 'http')) {
      toolsCache.set(serverId, []);
      return [];
    }
    if (toolsCache.has(serverId)) return toolsCache.get(serverId);
    uiLog(`POST /api/mcp/${serverId}/tools`);
    const data = await fetchJSON(`http://localhost:8787/api/mcp/${serverId}/tools`, {
      method:'POST', body: JSON.stringify({})
    });
    const tools = (data.tools || []).map(t=> ({ name: t.name, description: t.description || '' }));
    toolsCache.set(serverId, tools);
    return tools;
  }

  // ================= Intención “listar herramientas/capacidades” (fast-path) =================
  function isMcpCapabilitiesQuestion(text){
    const t = text.toLowerCase();
    const asksList =
      /\b(lista|listar|muestra|muéstrame|cuales|cuáles|que|qué)\b.*\b(tools|herramientas)\b/.test(t) ||
      /\bpuedes\b.*\b(listar|mostrar)\b.*\b(tools|herramientas)\b/.test(t) ||
      /\b(tools|herramientas)\b.*\bdisponibles\b/.test(t);
    const mentionsMcp = /\bmcp\b/.test(t);
    const genericWhatCanYouDo = /\bque\s+puedes\s+hacer\b/.test(t) || /\bwhat\s+can\s+you\s+do\b/.test(t);
    return { asksList, mentionsMcp, genericWhatCanYouDo };
  }
  function renderToolsSummary(tools){
    if (!tools || !tools.length) return 'Este servidor MCP no expone herramientas.';
    const lines = tools.slice(0, 20).map(t => `• ${t.name}: ${t.description ? t.description.slice(0,120) : ''}`);
    const extra = tools.length > 20 ? `\n…y ${tools.length - 20} más.` : '';
    return `Puedo invocar estas herramientas del servidor activo:\n` + lines.join('\n') + extra;
  }

  // ================= Prompts LLM =================
  function buildPlannerPrompt(userText, tools){
    const brief = (tools || []).slice(0, 30)
      .map(t=> `- ${t.name}: ${t.description ? t.description.slice(0,160) : ''}`)
      .join('\n');

    return `
Eres un asistente conectado a servidores del **Model Context Protocol (MCP)**.
Decide entre: (1) responder como chat, o (2) ejecutar una tool MCP del servidor activo.

Herramientas disponibles (nombre: descripción):
${brief || '(sin herramientas registradas)'}

Salida ESTRICTA en una sola línea JSON:
- Tool: {"action":"tool","name":"<tool_name>","arguments":{...}}
- Chat: {"action":"chat","reply":"<español, breve y claro>"}

Reglas:
- Si el usuario pide crear/leer/listar/mover archivos o comandos git, elige **tool** con argumentos válidos.
- Si el usuario pregunta por herramientas disponibles, responde **chat**.
Usuario: ${userText}
`;
  }
  function buildRefinePrompt(userText, toolName, toolArgs, toolResult){
    return `
Usuario: "${userText}".
Ejecutaste "${toolName}" con ${JSON.stringify(toolArgs)}.
Resultado JSON (puede ser largo):
${JSON.stringify(toolResult).slice(0, 4000)}

Redacta una respuesta clara y breve en español explicando lo que se hizo y el resultado. Sugiere siguiente paso si aplica.
`;
  }
  async function askLLM(prompt, context=[]) {
    const r = await fetch('http://localhost:8787/api/llm', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body: JSON.stringify({ prompt, context })
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${txt}`);
    try { return JSON.parse(txt); } catch { return { reply: txt }; }
  }

  // Helper para no romper si tu core no expone addAssistantMessage
  function safeAddAssistant(core, serverId, text){
    try {
      if (core && typeof core.addAssistantMessage === 'function') {
        core.addAssistantMessage(serverId, text);
      } else if (core && typeof core.addMessage === 'function') {
        core.addMessage({ serverId, role: 'assistant', content: text });
      }
    } catch {}
  }

  // === Parser local de intenciones (regex) -> devuelve {name, arguments} o null
  function parseLocalIntent(text, tools) {
    const t = text.trim();
    const lower = t.toLowerCase();
    const hasTool = (name) => (tools || []).some(x => x.name === name);

    // ---------- Filesystem helpers ----------
{
  const m = lower.match(/^(crea|crear|haz|make)\s+(carpeta|directorio|folder)\s+(.+)$/);
  if (m && hasTool('create_directory')) {
    const path = t.slice(m.index + m[0].length - m[3].length).trim();
    return { name: 'create_directory', arguments: normalizeFsArgs({ path }) };
  }
}
{
  const m = lower.match(/^(lista|listar|muestra|mostrar|ls)\s+(.+)$/);
  if (m) {
    const path = t.slice(m.index + m[0].length - m[2].length).trim();
    if (hasTool('list_directory')) return { name: 'list_directory', arguments: normalizeFsArgs({ path }) };
    if (hasTool('directory_tree')) return { name: 'directory_tree', arguments: normalizeFsArgs({ path }) };
  }
}
{
  const m = lower.match(/^(leer|lee|read)\s+(.+)$/);
  if (m && hasTool('read_text_file')) {
    const path = t.slice(m.index + m[0].length - m[2].length).trim();
    return { name: 'read_text_file', arguments: normalizeFsArgs({ path }) };
  }
}
{
  const m = t.match(/^(escribe|escribir|write)\s+"([^"]+)"\s+en\s+(.+)$/i);
  if (m && hasTool('write_file')) {
    const content = m[2];
    const path = m[3].trim();
    return { name: 'write_file', arguments: normalizeFsArgs({ path, content }) };
  }
}
{
  const m = t.match(/^(mover|mueve|renombra|rename|move)\s+(.+?)\s+(?:a|to)\s+(.+)$/i);
  if (m && hasTool('move_file')) {
    const source = m[2].trim();
    const destination = m[3].trim();
    return { name: 'move_file', arguments: normalizeFsArgs({ source, destination }) };
  }
}
{
  const m = t.match(/^(busca|buscar|search)\s+(?:en\s+)?(.+?)\s+(?:que\s+contenga|con|pattern|patr[oó]n)\s+(.+)$/i);
  if (m && hasTool('search_files')) {
    const path = m[1].trim();
    const pattern = m[2].trim().replace(/^"|"$/g,'');
    return { name: 'search_files', arguments: normalizeFsArgs({ path, pattern }) };
  }
}


    // ---------- Git atajos (status|log|diff|push) ----------
    {
      const m = lower.match(/^git\s+(status|log|diff|push)(?:\s+(.+))?$/);
      if (m) {
        const kind = m[1];

        if (kind === 'status' && hasTool('git_status')) return { name:'git_status', arguments:{} };
        if (kind === 'log'    && hasTool('git_log'))    return { name:'git_log', arguments:{ limit: 5 } };
        if (kind === 'diff'   && hasTool('git_diff'))   return { name:'git_diff', arguments:{} };

        if (kind === 'push' && hasTool('git_push')) {
          const rest = (m[2] || '').trim();

          let remote = 'origin';
          let branch = 'main';
          let set_upstream = false;
          let force = false;
          let include_tags = false;

          const slash = rest.match(/([^\s/]+)\/([^\s]+)/);
          if (slash) { remote = slash[1]; branch = slash[2]; }
          else if (rest) {
            const parts = rest.split(/\s+/).filter(Boolean);
            if (parts[0]) remote = parts[0];
            if (parts[1]) branch = parts[1];
          }

          if (/\bupstream\b|establece\s+upstream|config[úu]ralo\s+como\s+upstream/.test(rest)) set_upstream = true;
          if (/\bforzado\b|--force|-f\b/.test(rest)) force = true;
          if (/\btags?\b|--tags\b/.test(rest)) include_tags = true;

          const args = { remote, branch };
          if (set_upstream)  args.set_upstream = true;
          if (force)         args.force = true;
          if (include_tags)  args.include_tags = true;

          return { name:'git_push', arguments: args };
        }
      }
    }

    // ---------- Git en lenguaje natural común ----------
    {
      const cm = t.match(/^haz\s+commit\s+con\s+mensaje\s+"([^"]+)"(?:\s+usando\s+autor\s+(.+?)\s*<(.+?)>)?$/i);
      if (cm && hasTool('git_commit')) {
        const message = cm[1];
        const authorName = cm[2] || undefined;
        const authorEmail = cm[3] || undefined;
        const args = { message };
        if (authorName && authorEmail) { args.authorName = authorName; args.authorEmail = authorEmail; }
        return { name:'git_commit', arguments: args };
      }
    }
    {
      const cm2 = t.match(/^haz\s+commit\s+de\s+(.+?)\s+con\s+mensaje\s+"([^"]+)"$/i);
      if (cm2 && hasTool('git_commit')) {
        const files = cm2[1].split(/[,\s]+/).map(s=>s.trim()).filter(Boolean);
        const message = cm2[2];
        return { name:'git_commit', arguments: { files, message } };
      }
    }

    return null;
  }

  // ================= Envío =================
  async function doSend(){
    const text = msg.value.trim();
    if (!text) return;

    btnSend.disabled = true; btnSend.textContent = 'Enviando…';
    try {
      // Degradación: si el core no carga, LLM directo
      if (!coreReady) {
        const r = await llmDirect(text, []);
        setIO(`→ LLM(direct)\n${JSON.stringify({prompt:text,context:[]},null,2)}\n\n←\n${r.reply || r}`);
        msg.value = '';
        return;
      }

      const srv = core.current;

      // Mock: compatibilidad
      if (!srv.transport){
        const { request, response } = core.sendMock(text);
        setIO(`→ Mock\n${request.text}\n\n←\n${response.text}`);
        msg.value = '';
        return;
      }

      // MCP tools
      const tools = await ensureTools(srv.id);

      // Fast-path: listar herramientas/capacidades (sin LLM)
      {
        const intent = isMcpCapabilitiesQuestion(text);
        const hasTools = (tools && tools.length > 0);
        if ( (intent.mentionsMcp && (intent.asksList || intent.genericWhatCanYouDo))
          || (intent.asksList && hasTools)
          || (intent.genericWhatCanYouDo && hasTools) ) {
          const summary = renderToolsSummary(tools);
          setIO(`— Respuesta (cliente) —\n${summary}`);
          safeAddAssistant(core, srv.id, '[capabilities] listado de tools');
          msg.value = '';
          return;
        }
      }

      // Intento de mapeo local (regex) antes de llamar al LLM
      const localIntent = parseLocalIntent(text, tools);
      if (localIntent) {
        uiLog(`POST /api/mcp/${srv.id}/call ${localIntent.name} (localIntent)`);
        try{
          const result = await fetchJSON(`http://localhost:8787/api/mcp/${srv.id}/call`, {
            method:'POST', body: JSON.stringify({ name: localIntent.name, arguments: localIntent.arguments })
          });
          setIO(`→ tools/call\n${JSON.stringify({ name: localIntent.name, arguments: localIntent.arguments }, null, 2)}\n\n← result\n${JSON.stringify(result, null, 2)}`);
          safeAddAssistant(core, srv.id, `[tool:${localIntent.name}] OK`);
          msg.value = '';
          return;
        }catch(e){
          setIO(`→ tools/call\n${JSON.stringify({ name: localIntent.name, arguments: localIntent.arguments }, null, 2)}\n\n← error\n${String(e.message||e)}`);
          return;
        }
      }

      // Plan con LLM
      const planPrompt = buildPlannerPrompt(text, tools);
      uiLog('POST /api/llm (planner)');
      let plan;
      try {
        plan = await askLLM(planPrompt, core.buildContext(srv.id));
      } catch(e){
        setIO(`→ LLM(plan)\n${planPrompt}\n\n← error\n${String(e.message||e)}`);
        return;
      }

      // Decisión
      let decision = null;
      try { decision = JSON.parse((plan.reply||'').trim()); }
      catch { decision = { action:'chat', reply: (plan.reply||'').trim() || 'No entendí tu pedido.' }; }

      if (decision.action === 'tool'){
        const name = decision.name;
        const args = decision.arguments || {};
        const reqJson = JSON.stringify({ jsonrpc:'2.0', method:'tools/call', params:{ name, arguments: args } }, null, 2);

        // Ejecutar tool
        uiLog(`POST /api/mcp/${srv.id}/call ${name}`);
        let result;
        try{
          result = await fetchJSON(`http://localhost:8787/api/mcp/${srv.id}/call`, {
            method:'POST', body: JSON.stringify({ name, arguments: args })
          });
        }catch(e){
          setIO(`→ tools/call\n${reqJson}\n\n← error\n${String(e.message||e)}`);
          return;
        }

        // Redactar con LLM
        const refinePrompt = buildRefinePrompt(text, name, args, result);
        uiLog('POST /api/llm (refine)');
        let refined;
        try{
          refined = await askLLM(refinePrompt, core.buildContext(srv.id));
        }catch(e){
          setIO(`→ tools/call\n${reqJson}\n\n← result\n${JSON.stringify(result, null, 2)}\n\n— redactar: error —\n${String(e.message||e)}`);
          return;
        }

        setIO(`→ tools/call\n${reqJson}\n\n← result\n${JSON.stringify(result, null, 2)}\n\n— Respuesta —\n${refined.reply}`);
        safeAddAssistant(core, srv.id, `[tool:${name}] OK`);
        msg.value = '';
        return;
      }

      // Chat normal
      const chatReq = { prompt: text, context: core.buildContext(srv.id) };
      uiLog('POST /api/llm (chat)');
      let chat;
      try{
        chat = await askLLM(chatReq.prompt, chatReq.context);
      }catch(e){
        setIO(`→ LLM\n${JSON.stringify(chatReq, null, 2)}\n\n← error\n${String(e.message||e)}`);
        return;
      }
      setIO(`→ LLM\n${JSON.stringify(chatReq, null, 2)}\n\n←\n${chat.reply}`);
      msg.value = '';
    } catch (e){
      setIO(JSON.stringify({ error: String(e?.message || e) }, null, 2));
    } finally {
      btnSend.disabled = false; btnSend.textContent = 'Enviar';
    }
  }

  // ================= Boot core con degradación =================
  async function boot(){
    try{
      if (typeof P1Core === 'undefined' || !P1Core.createBrowserCore) {
        uiLog('P1Core no disponible; usaré modo LLM directo.');
        coreReady = false; updateCtxInfo(); return;
      }
      core = P1Core.createBrowserCore({});
      core.onLog((line)=> uiLog(line));
      await core.boot();
      coreReady = true;
      renderServers();
      updateCtxInfo();
      await ensureTools(core.current?.id);
      uiLog('Core listo.');
    }catch(e){
      uiLog(`Fallo boot core: ${String(e.message||e)} — usaré modo LLM directo.`);
      coreReady = false; updateCtxInfo();
    }
  }

  // ================= Wiring =================
  window.addEventListener('DOMContentLoaded', async ()=>{
    await boot();
    btnSend.addEventListener('click', doSend);
    msg.addEventListener('keydown', (ev)=>{
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault(); btnSend.click();
      }
    });
    serverSelect.addEventListener('change', async (e)=> {
      if (!coreReady) return;
      core.setServerById(e.target.value);
      renderServers();
      await ensureTools(e.target.value);
    });
    btnNew.addEventListener('click', ()=> {
      if (coreReady) { core.resetSession(core.current.id); }
      io.textContent='{}'; logBox.textContent='';
    });
    btnExport.addEventListener('click', ()=>{
      if (!coreReady) return;
      const url = core.exportSession(core.current.id);
      const a = document.createElement('a'); a.href = url; a.download = `session-${core.current.id}.json`; a.click();
    });
  });
})();