/* UMD: window.P1Core en navegador, module.exports en Node */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('fs'), require('path'));
  } else {
    root.P1Core = factory(null, null);
  }
}(typeof self !== 'undefined' ? self : this, function (fs, path) {
  const DEFAULT_CONTEXT_TURNS = 6;

  // ---------- helpers de tamaño ----------
  function bytesOf(str){
    try {
      if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(str||'')).byteLength;
    } catch(_) {}
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(String(str||''), 'utf8');
    return String(str||'').length; // último recurso
  }
  function trimByBytes(str, maxBytes){
    let s = String(str||'');
    if (bytesOf(s) <= maxBytes) return s;
    // búsqueda binaria para cortar en el límite
    let lo = 0, hi = s.length;
    while (lo < hi){
      const mid = (lo + hi) >> 1;
      if (bytesOf(s.slice(0, mid)) <= maxBytes) lo = mid + 1; else hi = mid;
    }
    return s.slice(0, Math.max(0, hi-1)) + ' …';
  }

  // ---------- Storage Adapters ----------
  function BrowserLocalStorageStorage(prefix='p1host.session.') {
    return {
      loadSession(serverId) {
        try {
          const raw = localStorage.getItem(prefix + serverId);
          if (!raw) return { messages: [], createdAt: Date.now() };
          const p = JSON.parse(raw);
          return { messages: p.messages || [], createdAt: p.createdAt || Date.now(), summary: p.summary || '' };
        } catch {
          return { messages: [], createdAt: Date.now() };
        }
      },
      saveSession(serverId, data) {
        localStorage.setItem(prefix + serverId, JSON.stringify(data));
      },
      exportSession(_serverId, _data, _outPath) {
        const blob = new Blob([JSON.stringify(_data, null, 2)], { type: 'application/json' });
        return URL.createObjectURL(blob);
      }
    };
  }

  function NodeFsStorage(dir='sessions') {
    const ensure = () => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive:true }); };
    const sp = (id) => path.join(dir, `session-${id}.json`);
    return {
      loadSession(serverId) {
        ensure();
        const f = sp(serverId);
        if (!fs.existsSync(f)) return { messages: [], createdAt: Date.now() };
        try {
          const p = JSON.parse(fs.readFileSync(f, 'utf8'));
          return { messages: p.messages || [], createdAt: p.createdAt || Date.now(), summary: p.summary || '' };
        } catch {
          return { messages: [], createdAt: Date.now() };
        }
      },
      saveSession(serverId, data) {
        ensure();
        fs.writeFileSync(sp(serverId), JSON.stringify(data, null, 2));
      },
      exportSession(serverId, data, outPath) {
        ensure();
        const out = outPath || path.join(process.cwd(), `session-${serverId}.json`);
        fs.writeFileSync(out, JSON.stringify(data, null, 2));
        return out;
      }
    };
  }

  // ---------- Core Factory ----------
  function createCore({ storage, serversProvider, contextTurns = DEFAULT_CONTEXT_TURNS, logger = console }) {
    // Límites
    const MAX_CONTEXT_BYTES  = 2048;     // ~2KB por request al LLM
    const MAX_SESSION_BYTES  = 500*1024; // ~0.5MB por sesión de server
    const SUMMARY_BULLETS    = 5;

    const state = {
      servers: [],
      current: null,
      sessions: {},
      logs: [],
      listeners: { log: [] }
    };
    const rid = () => Math.floor(Math.random()*1e9);
    const now = () => new Date().toISOString();
    const onLog = (cb) => state.listeners.log.push(cb);
    const pushLog = (line) => {
      const s = `[${now()}] ${line}`;
      state.logs.push(s);
      state.listeners.log.forEach(fn => { try { fn(s); } catch(_){} });
      (logger && logger.log) ? logger.log(s) : null;
      return s;
    };

    function loadSession(id) {
      if (!state.sessions[id]) state.sessions[id] = storage.loadSession(id);
      return state.sessions[id];
    }
    function saveSession(id) { storage.saveSession(id, state.sessions[id]); }
    function resetSession(id) { state.sessions[id] = { messages: [], createdAt: Date.now(), summary: '' }; saveSession(id); }
    function exportSession(id, outPath) { return storage.exportSession(id, state.sessions[id], outPath); }

    function setServerById(id) {
      const next = state.servers.find(s => s.id === id);
      if (!next) throw new Error(`Server not found: ${id}`);
      state.current = next;
      loadSession(id);
      pushLog(`server:switched -> ${next.id}${next.url ? ` (${next.url})` : ''}`);
    }

    // --- Compacta sesión si excede el límite ---
    function compactSessionIfNeeded(id){
      const sess = state.sessions[id];
      if (!sess) return;
      const rawSize = bytesOf(JSON.stringify(sess));
      if (rawSize <= MAX_SESSION_BYTES) return;

      // Mantén últimos contextTurns*2 mensajes detallados
      const keepCount = contextTurns * 2;
      const keep = sess.messages.slice(-keepCount);
      const older = sess.messages.slice(0, Math.max(0, sess.messages.length - keepCount));

      if (older.length){
        const bullets = older.slice(-SUMMARY_BULLETS).map(m => {
          const t = (m.preview ?? m.text ?? '').replace(/\s+/g,' ').slice(0, 160);
          const who = m.role === 'host' ? 'Usuario' : 'Asistente';
          return `- ${who}: ${t}`;
        }).join('\n');
        const prefix = sess.summary ? (sess.summary + '\n') : '';
        // ~2KB para el summary acumulado
        sess.summary = trimByBytes(prefix + bullets, 2000);
      }

      sess.messages = keep;
      pushLog(`session:compacted -> ${id} (size was ~${Math.round(rawSize/1024)}KB)`);
    }

    // --- Construye contexto con límites por bytes + resumen opcional ---
    function buildContext(id) {
      const sess = state.sessions[id] || { messages: [] };
      const msgs = (sess.messages || [])
        .filter(m => m.role === 'host' || m.role === 'server');

      const parts = [];

      // 1) Resumen acumulado (si existe)
      if (sess.summary && typeof sess.summary === 'string' && sess.summary.trim()){
        parts.push({ role: 'system', content: trimByBytes(sess.summary, Math.floor(MAX_CONTEXT_BYTES * 0.35)) });
      }

      // 2) Últimos N turnos (host/server)
      const recent = msgs.slice(-contextTurns).map(m => ({
        role: m.role === 'host' ? 'host' : 'server',
        content: m.preview ?? m.text
      }));

      // 3) Repartir presupuesto de bytes entre las partes
      const totalParts = (parts.length + recent.length) || 1;
      const out = [];
      let used = 0;

      for (const part of [...parts, ...recent]) {
        const remaining = Math.max(0, MAX_CONTEXT_BYTES - used);
        if (remaining <= 0) break;
        const allowance = Math.max(64, Math.floor(remaining / (totalParts - out.length)));
        const trimmed = { ...part, content: trimByBytes(part.content, allowance) };
        used += bytesOf(trimmed.content);
        out.push(trimmed);
      }
      return out;
    }
    function getContextTurns() { return contextTurns; }

    // --- MOCK send (sin red) ---
    function sendMock(text) {
      if (!state.current) throw new Error('No server selected');
      const srv = state.current;
      const sess = state.sessions[srv.id];
      const id = rid();
      const ts = Date.now();
      const context = buildContext(srv.id);

      const request = {
        jsonrpc: '2.0',
        id,
        method: 'chat.echo',
        params: {
          message: text,
          session: { serverId: srv.id, createdAt: sess.createdAt },
          context
        }
      };
      const hostMsg = { role: 'host', serverId: srv.id, ts, text: JSON.stringify(request, null, 2), preview: `host: ${text}` };
      sess.messages.push(hostMsg);
      saveSession(srv.id);

      const response = { jsonrpc: '2.0', id, result: { reply: `(${srv.label}) Entendido: "${text}"` } };
      const serverMsg = { role: 'server', serverId: srv.id, ts: Date.now(), text: JSON.stringify(response, null, 2), preview: `server: ${response.result.reply}` };
      sess.messages.push(serverMsg);

      // compacta + guarda
      compactSessionIfNeeded(srv.id);
      saveSession(srv.id);

      pushLog(`request -> method=chat.echo server=${srv.id} msg="${text}"`);
      pushLog(`response <- ok server=${srv.id}`);
      return { request: hostMsg, response: serverMsg };
    }

    // --- Envío a LLM vía proxy HTTP (para UI) ---
    async function sendProxyLlm(text, { proxyUrl = 'http://localhost:8787/api/llm' } = {}) {
      if (!state.current) throw new Error('No server selected');
      const srv = state.current;
      const sess = state.sessions[srv.id];
      const ts = Date.now();
      const ctx = buildContext(srv.id);

      const reqObj = { provider: 'gemini', method: 'llm.ask', params: { prompt: text, context: ctx } };
      const hostMsg = { role: 'host', serverId: 'llm', ts, text: JSON.stringify(reqObj, null, 2), preview: `host(llm): ${text}` };
      sess.messages.push(hostMsg);
      saveSession(srv.id);
      pushLog(`request -> llm.ask (proxy) server=${srv.id} msg="${text}"`);

      let serverMsg;
      try {
        const r = await fetch(proxyUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: text, context: ctx }) });
        if (!r.ok) {
          const err = await r.text().catch(()=> '')
          serverMsg = { role: 'server', serverId: 'llm', ts: Date.now(), text: JSON.stringify({ error: `Proxy ${r.status}`, details: err }, null, 2), preview: 'llm:error' };
        } else {
          const data = await r.json();
          serverMsg = { role: 'server', serverId: 'llm', ts: Date.now(), text: JSON.stringify({ provider:'gemini', result: data }, null, 2), preview: `llm: ${String(data.reply || '').slice(0,120)}` };
        }
      } catch (e) {
        serverMsg = { role: 'server', serverId: 'llm', ts: Date.now(), text: JSON.stringify({ error: 'Proxy fetch failed', details: String(e.message||e) }, null, 2), preview: 'llm:error' };
      }

      sess.messages.push(serverMsg);
      // compacta + guarda
      compactSessionIfNeeded(srv.id);
      saveSession(srv.id);

      pushLog(`response <- llm (proxy)`);
      return { request: hostMsg, response: serverMsg };
    }

    // --- Boot ---
    async function boot() {
      const servers = await serversProvider();
      if (!Array.isArray(servers) || servers.length === 0) throw new Error('serversProvider() returned empty list');
      state.servers = servers;
      state.current = servers[0];
      loadSession(state.current.id);
      pushLog(`server:init -> ${state.current.id}${state.current.url ? ` (${state.current.url})` : ''}`);
      return servers;
    }

    return {
      get servers() { return state.servers; },
      get current() { return state.current; },
      get sessions() { return state.sessions; },
      get logs() { return state.logs; },

      boot, setServerById, resetSession, exportSession, onLog,
      sendMock, buildContext, getContextTurns, sendProxyLlm
    };
  }

  // ---------- Convenience creators ----------
  async function defaultBrowserServersProvider() {
    const res = await fetch('servers.json');
    return res.json();
  }
  function createBrowserCore(opts={}) {
    return createCore({
      storage: BrowserLocalStorageStorage(opts.prefix),
      serversProvider: opts.serversProvider || defaultBrowserServersProvider,
      contextTurns: opts.contextTurns || DEFAULT_CONTEXT_TURNS,
      logger: console
    });
  }

  function defaultNodeServersProvider(fsNode, pathNode, file='servers.json') {
    const p = pathNode.join(__dirname, file);
    return () => JSON.parse(fsNode.readFileSync(p, 'utf8'));
  }
  function createNodeCore(opts={}) {
    const sp = opts.serversProvider || defaultNodeServersProvider(fs, path, opts.serversFile || 'servers.json');
    return createCore({
      storage: NodeFsStorage(opts.sessionsDir || 'sessions'),
      serversProvider: async () => sp(),
      contextTurns: opts.contextTurns || DEFAULT_CONTEXT_TURNS,
      logger: console
    });
  }

  return { createCore, createBrowserCore, createNodeCore };
}));