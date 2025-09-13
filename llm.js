// llm.js - Cliente mínimo para Anthropic (Claude)
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_KEY = process.env.ANTHROPIC_API_KEY; // exporta tu key en el shell

if (!API_KEY) {
  console.warn('⚠️ Falta ANTHROPIC_API_KEY en el entorno. :ask fallará hasta que la configures.');
}

/**
 * ask({ prompt, contextTurns }): Llama al LLM con una ventana de contexto.
 * - prompt: string (tu pregunta nueva)
 * - contextTurns: Array<{role:'host'|'server', content:string}>
 * Devuelve: { reply, tokens?: any }
 */
async function ask({ prompt, contextTurns = [] }) {
  if (!API_KEY) throw new Error('No ANTHROPIC_API_KEY set');

  // Compacta el contexto a un texto breve. (Puedes pulirlo luego.)
  const ctxText = contextTurns.map(t => {
    const who = t.role === 'host' ? 'User' : 'Server';
    // recorte simple para no excederte
    const msg = String(t.content).replace(/\s+/g, ' ').slice(0, 300);
    return `${who}: ${msg}`;
  }).join('\n');

  const userContent = ctxText
    ? `Contexto (resumen):\n${ctxText}\n\nPregunta:\n${prompt}`
    : `Pregunta:\n${prompt}`;

  const body = {
    model: 'claude-3-haiku-20240307', // estable/barato; cambia si quieres
    max_tokens: 300,
    temperature: 0.2,
    messages: [
      { role: 'user', content: userContent }
    ]
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    throw new Error(`LLM HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  const reply = (data?.content?.[0]?.text ?? '').trim();
  return { reply, tokens: { input: data?.usage?.input_tokens, output: data?.usage?.output_tokens } };
}

module.exports = { ask };