# P1-Redes - Chat MCP con UI Web

Chat con ejecución de herramientas MCP. Interfaz web con chat a la izquierda y Request/Response + Log a la derecha.

## Setup Rápido

```bash
npm install
```

Crea `.env`:
```
GROQ_API_KEY=tu_key_aqui
GROQ_MODEL=llama-3.1-8b-instant
GROQ_MAX_TOKENS=256
GROQ_TEMPERATURE=0.2
```

## Ejecutar

Terminal 1 (proxy):
```bash
node api-proxy.js
```

Terminal 2 (UI):
```bash
npx http-server . -p 5500 -c-1
```

Ve a `http://127.0.0.1:5500`

## Servidores MCP Configurados

- **fs**: Manejo de archivos (stdio oficial)
- **git**: Git operations (stdio oficial)  
- **remote-http**: Servidor remoto via túnel loca.lt
- **mio-local-http**: Mi servidor HTTP local

## Uso

Selecciona servidor y habla en natural:
- "¿qué herramientas hay?"
- "crea carpeta test"
- "git status"
- "lee archivo.txt"

El asistente decide si chatear o ejecutar tools automáticamente.

## Estructura

```
/P1-Redes
  index.html        # UI principal
  app.js           # Lógica cliente
  core.js          # Manejo sesiones
  api-proxy.js     # Proxy LLM+MCP
  servers.json     # Config servidores
  sessions/        # Exports
```

## Capturas de Red

Para análisis Wireshark:
```bash
sudo tcpdump -i en0 -w capture.pcap host servidor.com and port 443
```

## Troubleshooting

- **FS fuera de jaula**: Usar rutas dentro del directorio permitido
- **Túnel 503**: Reiniciar loca.lt
- **Groq 429**: Bajar GROQ_MAX_TOKENS

---
*Proyecto académico - Servidores MCP oficiales son de sus respectivos autores*