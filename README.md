# MALIK-MD Session Generator

Generates a SESSION_ID for the MALIK-MD WhatsApp bot.

## How it works

1. User enters their WhatsApp number -> POST /api/pair
2. Server creates a temp auth session + Baileys pairing code (valid ~4 min)
3. User enters the code in WhatsApp (Linked Devices -> "Link with phone number instead")
4. On connection open, server uploads creds to Mega and shows the session ID
5. Temp session dir is deleted immediately after

## Deploy
Push the repo to GitHub, then create a Render Web Service: build npm install, start npm start.
Set the two Mega account values from .env.example as environment variables on Render.

Local: npm install, copy .env.example to .env, fill your values, npm start.

Security: a session ID equals a WhatsApp login. Temp auth folders are deleted after issue or after 4 minutes. Rate limit 5 per hour per IP.
