# DHIUFIQH Writing Platform

This app now saves writings permanently to `data/writings.json` through a small Node.js server.

## Run

```powershell
npm start
```

Then open:

```text
http://localhost:3002
```

## Storage

- `GET /api/writings` reads all writings
- `POST /api/writings` adds a new writing
- `DELETE /api/writings/:id` removes a writing
- `data/writings.json` keeps the permanent JSON data
