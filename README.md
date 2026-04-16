# Bonko (Prototype)

A browser multiplayer social-chaos game with a React frontend and Socket.IO backend.

## Current Game Loop

- 1 random player is Shadow
- Everyone else is Crew
- Crew wins by collecting shard points before timer ends
- Shadow wins by tagging all Crew players
- Host can reset back to lobby and restart rounds
- Practice mode adds bots so you can play solo or warm up before a real match
- Chaos mode runs a faster, denser version of the game

## Match Modes

- Classic: original rules, no bots
- Practice: bots fill the room and the pace is a little faster
- Chaos: higher pace, more shards, and more pressure

## Lobby Settings

- Host can switch modes before starting a round
- Practice and Chaos support adjustable bot counts
- Movement pace is now tuned to feel snappier in live play

## Tech

- Node.js + Express server
- Socket.IO real-time state sync
- React + Vite frontend
- Canvas renderer with light interpolation for smoother motion

## Scale Target

- Designed for small rooms with 5-10 players
- Hard room cap currently set to 10
- Server-authoritative movement and outcomes

## Run Locally

1. Install dependencies:

   npm install

2. Start full dev setup (server + React frontend):

   npm run dev

3. Open browser:

   <http://localhost:5173>

## Production-like Serve

1. Build frontend:

   npm run build:client

2. Run server:

   npm start

3. Open browser:

   <http://localhost:3000>

## Deploy For Real Players

This game needs a persistent Node.js process for Socket.IO rooms/ticks, so deploy in two parts:

1. Backend (Node + Socket.IO) on Render/Railway/Fly/VPS
2. Frontend (React/Vite) on Vercel

### Backend Environment Variables

Set these on your backend host:

- PORT=3000 (or provided by host)
- `CORS_ORIGIN=https://your-vercel-app.vercel.app`

You can allow multiple frontend origins by comma-separating:

- `CORS_ORIGIN=https://your-vercel-app.vercel.app,https://preview-url.vercel.app`

### Frontend Environment Variables (Vercel)

Set this in Vercel project settings:

- `VITE_SOCKET_URL=https://your-backend-domain.com`

### Vercel Project Settings

- Framework: Vite
- Root Directory: .
- Build Command: npm run build
- Output Directory: public/app

### Quick Verification

1. Open the Vercel URL in two browser windows/devices.
2. Create room in one window and join from the second.
3. Start round and verify movement, shards, and tag events sync in real time.

## Controls

- Move: WASD or Arrow Keys
- Shadow action: Space to tag nearby crew
