# Still

**Own the silence.**

A calm, local-first personal key and secret manager.  
No accounts. No cloud. Everything stays on your device and encrypted.

Built with Tauri v2 + Next.js + libsodium.

## Getting Started

Clone the repository:

```bash
git clone https://github.com/yourusername/still.git
cd still
npm install
npm run dev
```

This gives you the full source code. You can also build the desktop app from here.

### Running the Desktop App (Tauri)

After cloning the repository:

```bash
npm run tauri:dev          # Run in development
npm run tauri:build        # Build production desktop app
```

Pre-built desktop versions are also available on the Releases page.

### Philosophy

Privacy through strong local encryption.

Still keeps your secrets encrypted at rest on your device using modern cryptography and your master password. Nothing leaves your machine. When you're finished with a Lens, explicitly forget it, it moves to the Recycle Bin and is permanently deleted after 7 days.

### Security & Transparency

Still is designed for people who care about privacy.

- All data is encrypted on your device before storage.
- No accounts, no servers, no telemetry.
- You can always clone the repository and build it yourself if you prefer not to trust pre-built binaries.
- The entire codebase is open and intentionally minimal.

### Features

- Lenses. Separate encrypted spaces for different parts of your life
- Strong local encryption. Argon2id + XChaCha20-Poly1305
- Recycle Bin. Safely delete and restore Lenses
- Minimal interface. Calm and distraction-free by design
- Local only. No accounts, no servers, no telemetry

### License
MIT
---
Crafted with care as a solo project.
---