```markdown
# Interestelar — Prototipo Servidor Autoritativo

Contenido
- server-authoritative.js : servidor Express + Socket.IO autoritativo por sala.
- public/juegoonline2.html : cliente HTML (juego) con script completo integrado.
- public/online-authoritative-client.js : cliente que gestiona auth, inputs, predicción, reconciliación y telemetría.
- package.json, Dockerfile, render.yaml, README.md, .gitignore

Instalación local
1. npm install
2. JWT_SECRET=tu_secret npm start
3. Abrir http://localhost:3000/juegoonline2.html en dos pestañas.

Despliegue en Render
- Subir repo a GitHub.
- Crear Web Service en Render, configurar JWT_SECRET como variable de entorno.
- Build: npm install
- Start: node server-authoritative.js

Notas
- Este prototipo no es producción. Añadir persistencia, autenticación robusta y validaciones/restricciones antes de exponer públicamente.
```