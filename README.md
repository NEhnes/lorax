---
title: "Lorax Hotline"
date: "[PROJECT DATE]"
team_size: "[TEAM SIZE]"
scope: "An iMessage forest-guardian agent that researches company claims and prepares human-sent action kits."
skills: ["TypeScript", "Bun", "Agent tool use", "iMessage integration", "Source validation"]
---

# Lorax Hotline

A grumpy forest guardian you can text. Lorax Hotline replies in character and can prepare a sourced action kit about a company; it does not message companies.

## Highlights

- **iMessage send and receive manually verified.**
- Uses an OpenRouter-compatible chat API with a manual tool-use loop.
- Persists sourced company claims as local dossier files.
- Action-kit research and drafting are implemented; **end-to-end behavior remains unverified**.

## Table of Contents

- [Overview](#overview)
- [Skills Demonstrated](#skills-demonstrated)
- [Technical Summary](#technical-summary)
- [Design Challenges](#design-challenges)
- [Run Locally](#run-locally)

## Overview

| | |
|---|---|
| Scope | Inbound iMessage agent and company action-kit drafts |
| Date | [PROJECT DATE] |
| Duration | [DURATION] |
| Team | [TEAM SIZE] |

The project explores using conversational AI to turn environmental research into practical next steps. It keeps outreach human-controlled: the agent prepares claims and draft messages, while the user decides whether to send them.

## Skills Demonstrated

### Software and Integration
- Built a TypeScript message loop with Bun and Spectrum’s iMessage provider.
- Connected an OpenAI-compatible chat-completions API and implemented tool-call handling.
- Added web-search and dossier-saving tools, with source-URL checks on saved claims.

### Testing and Safety
- Manually verified inbound and outbound iMessage delivery.
- Defaults to dry-run mode; real replies require `DRY_RUN=false`.
- [ADD OTHER VERIFIED TEST RESULTS OR METRICS]

## Technical Summary

The runtime receives text messages through Spectrum, passes them to the agent, and sends the response unless dry-run mode is active. The agent uses OpenRouter tool calls for search and dossier persistence; dossiers are stored as JSON under `data/dossiers/`.

### Messaging and Agent
- `src/index.ts` routes inbound iMessages and controls dry-run sending.
- `src/agent.ts` manages the model/tool loop and prepares action-kit responses.
- `src/persona.ts` defines the short, original forest-guardian voice.

### Tools and State
- `src/tools.ts` queries DuckDuckGo Instant Answer and validates dossier source URLs.
- `src/store.ts` persists dossier records locally.
- Search coverage and full action-kit output have not been verified end-to-end.

## Design Challenges

- **Keep outreach human-controlled** → Automated company messaging could create unwanted contact → Make the agent prepare drafts and leave sending to the user.
- **Avoid unsourced dossier claims** → Model-generated facts may be unreliable → Require saved claim URLs to match results returned by the search tool.
- **Test safely against a live messaging provider** → Real sends affect recipients → Default to dry-run and make live replies an explicit environment setting.

## Run Locally

Requirements: [BUN VERSION] and configured Spectrum and OpenRouter credentials.

1. Install dependencies with `bun install`.
2. Copy `.env.example` to `.env` and set the required credentials and model.
3. Start with `bun run dev`.

`DRY_RUN` defaults to `true`. Set it to `false` only when you intend to send replies through the connected iMessage provider. Keep secrets in `.env`; do not commit them.

To request an action kit, text `pester <company>`. Review any generated research and draft before using it; source coverage and end-to-end action-kit behavior still need verification.
