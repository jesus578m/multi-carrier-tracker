# Imagen oficial de Playwright con Chromium y todas las dependencias del sistema
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

# Carpeta de trabajo
WORKDIR /app

# Instalar dependencias del proyecto
COPY package*.json ./
RUN npm ci

# Asegurar navegadores (por si la imagen cambia de versión)
RUN npx playwright install chromium

# Copiar el resto del código
COPY . .

# Variables de entorno
ENV NODE_ENV=production
ENV PORT=8080
ENV USE_SCRAPE=1

# Exponer el puerto donde escucha tu servidor
EXPOSE 8080

# Comando de arranque (usa "npm start" -> debe lanzar tu server, ej. server.js)
CMD ["npm", "start"]
