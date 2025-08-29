# Imagen oficial de Playwright con Chromium y todas las dependencias
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

# Manifiestos
COPY package*.json ./

# Dependencias del proyecto
RUN npm install

# Navegadores de Playwright (Chromium)
RUN npx playwright install chromium

# Código de la app
COPY . .

# Vars de entorno
ENV NODE_ENV=production
ENV PORT=8080
ENV USE_SCRAPE=1

EXPOSE 8080
CMD ["npm", "start"]
