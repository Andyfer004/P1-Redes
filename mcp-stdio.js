// mcp-stdio.js
const { spawn } = require('child_process');

function createJsonRpc(){
  let nextId = 1;
  const pending = new Map();
  return {
    newId: () => nextId++,
    wait: (id) => new Promise((res, rej)=> pending.set(id, {res, rej})),
    settle: (msg) => {
      const { id } = msg;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if ('result' in msg) p.res(msg.result);
      else p.rej(msg.error || new Error('RPC error'));
    }
  };
}
function lineDecoder(onLine){
  let buf = '';
  return (chunk)=>{
    buf += chunk.toString('utf8');
    let idx;
    while((idx = buf.indexOf('\n')) >= 0){
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx+1);
      if (line) onLine(line);
    }
  };
}

function createStdIoClient({ cmd, args=[], cwd=process.cwd(), env=process.env }){
  const child = spawn(cmd, args, { cwd, env, stdio: ['pipe','pipe','pipe'] });
  const rpc = createJsonRpc();

  child.stdout.on('data', lineDecoder((line)=>{
    try{
      const msg = JSON.parse(line);
      if (msg.id) rpc.settle(msg);
    }catch(_){}
  }));

  // Log de errores del proceso hijo
  child.stderr.on('data', (d)=>{
    const msg = d.toString();
    console.error(`[stdio-child] STDERR: ${msg}`);
  });

  function send(obj){
    child.stdin.write(JSON.stringify(obj) + '\n');
  }

  async function initialize(){
    const id = rpc.newId();
    const p = rpc.wait(id);
    send({
      jsonrpc:'2.0',
      id,
      method:'initialize',
      params:{
        protocolVersion:'2025-06-18',
        clientInfo:{ name:'P1-Host-CLI', version:'1.0.0' },
        capabilities:{}
      }
    });
    await p;

    // Notificación requerida por varios servers (incluido mcp-server-git)
    send({ jsonrpc:'2.0', method:'notifications/initialized', params:{} });
    await new Promise(r => setTimeout(r, 30));

    return true;
  }

  async function toolsList(){
    const id = rpc.newId();
    const p = rpc.wait(id);
    send({ jsonrpc:'2.0', id, method:'tools/list', params:{} });
    return p;
  }

  async function toolsCall(name, params){
    const id = rpc.newId();
    const p = rpc.wait(id);
    send({ jsonrpc:'2.0', id, method:'tools/call', params:{ name, arguments: params || {} } });
    return p;
  }

  function close(){ try{ child.kill(); }catch(_){} }

  return { initialize, toolsList, toolsCall, close, child };
}

module.exports = { createStdIoClient };