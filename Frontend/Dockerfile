FROM node:22-alpine AS build

WORKDIR /app

# Install from the lock file so the hosted bundle matches the verified frontend dependencies.
COPY package.json package-lock.json ./
RUN npm ci

# Build a minified static bundle with same-origin API requests by default.
COPY . .
ARG VITE_API_URL=
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

FROM nginx:1.29-alpine

# Serve the optimized React assets and proxy API and WebSocket requests to Flask.
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
