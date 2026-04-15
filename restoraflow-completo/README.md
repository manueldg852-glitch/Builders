# RestoraFlow v5

Field documentation platform for property damage restoration. Self-hosted, zero API costs.

## Quick Start

```bash
cp .env.example .env          # configure passwords
docker compose up -d          # starts all 8 services
docker compose exec api pnpm prisma migrate deploy
docker compose exec api pnpm prisma db seed
```

Open http://localhost:3000 — login: `admin@yourcompany.com` / `Admin1234!`

## Stack

| Layer | Tech |
|---|---|
| Frontend | Next.js 14 + TypeScript + Recharts |
| Backend | NestJS (Clean Architecture) |
| Database | PostgreSQL 16 + Prisma |
| Storage | MinIO (S3-compatible, self-hosted) |
| AI | Ollama: Llama 3 (narratives) + Moondream2 (vision) |
| Queue | BullMQ + Redis |
| PDF | Puppeteer + Handlebars |
| Offline | Dexie.js (IndexedDB) + Workbox |

## Services (docker-compose)

| Service | Port | Purpose |
|---|---|---|
| app | 3000 | Next.js frontend |
| api | 3001 | NestJS API + Swagger at `/api/docs` |
| db | 5432 | PostgreSQL |
| redis | 6379 | BullMQ queues |
| minio | 9000/9001 | Object storage + console |
| ollama | 11434 | AI models |
| bull-board | 3002 | Queue monitor |

## Architecture

```
core/         → Domain entities, ports (interfaces), use cases — zero deps
infrastructure/ → Prisma repo, MinIO adapter, Ollama adapter, BullMQ workers
application/  → NestJS controllers, DTOs, modules
shared/       → Guards, decorators, filters
```

## Features

- **13 pages:** Dashboard, Projects, Dispatch Board, Field View, Equipment, Reports, Billing, Client Portal, Analytics, Technicians, Clients, Settings
- **Project Detail tabs:** Rooms, Moisture Log, Drying Calculator, Floor Plan Pins, Equipment, E-Sign, AI Narrative, Estimator (60+ IICRC cost codes), Project Info
- **Offline-first PWA:** All field operations work offline, sync in background
- **AI narratives:** Llama 3 converts field notes to IICRC-grade insurance prose
- **Photo AI:** Moondream2 auto-tags damage photos
- **PDF reports:** Puppeteer generates insurance-ready documents from Handlebars templates
- **Equipment alerts:** Red banner when project closes with units still deployed
- **Magic Links:** Homeowners view project progress without an account
- **E-Sign:** Canvas-based digital signatures on any device
- **Interactive Floor Plans:** Click to place damage pins with severity ratings
