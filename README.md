# Lorax Hotline

Inbound-first iMessage agent powered by OpenRouter. It answers in character and can research deforestation claims.

## Setup

1. Install [Bun](https://bun.sh/).
2. Install dependencies with `bun install`.
3. Copy `.env.example` to `.env`, set `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, and `OPENROUTER_API_KEY`. OpenRouter defaults to `xiaomi/mimo-v2.5`; adjust `OPENROUTER_BASE_URL` or `OPENROUTER_MODEL` only if needed. Keep `DRY_RUN=true` to log generated replies without sending them; set it to `false` only when explicitly testing real replies.
4. Start with `bun run dev`. Photon cloud iMessage credentials are required to receive inbound messages.

See `claude.md` for the phased implementation plan and project constraints.
