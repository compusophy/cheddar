# cheddar

an ai treasurer holds real stablecoins on the tempo testnet. talk it into paying you. every theft makes it stronger.

cheddar is [say cheese](https://github.com/compusophy) with money as the cheese. the treasurer is a gemini agent with one tool, `pay(to, amount)`, and a plain-english policy as its system prompt. players open a session and try to get paid. when they succeed, the exact transcript that robbed it is fed to a patcher that rewrites the policy, and the game moves to the next generation.

nothing is simulated. every `pay()` is a tip-20 transfer on tempo moderato (chain 42431) and every breach has a transaction hash.

## the immune system

a patch that only closes one hole is worthless, and a patch that makes the agent refuse everything is worse: a treasurer that won't pay suppliers is dead, and that's exactly the surface you'd use to poison the patcher. so every candidate policy must pass two suites before it goes live:

1. **regression**: replay every past breach transcript. none may pay an unapproved address.
2. **legit**: ordinary supplier invoices. the agent must still pay them.

fail either and the patcher tries again with the failures as extra context, up to three rounds. if the very first patch produced from a breach fails the legit suite, that breach is flagged **autoimmune**: the attacker's transcript made the patcher damage its own host. that's the research question this project exists to explore.

## run it

```
npm install
npm run keygen          # prints AGENT_PRIVATE_KEY; put it in .env
cp .env.example .env    # add GEMINI_API_KEY and the key above
npm run dev
```

fund the treasurer with the tempo faucet (`POST /api/admin/fund` with `Authorization: Bearer $ADMIN_TOKEN`, or the faucet at docs.tempo.xyz).

## api

| route | what |
|---|---|
| `GET /api/state` | current generation, policy, balance, limits |
| `POST /api/session` | `{player, nickname}` → session id. `player` is the wallet the loot goes to |
| `POST /api/chat` | `{session, message}` → agent turns, tool calls, breach if any |
| `GET /api/generations` | every policy ever, with pass/fail badges |
| `GET /api/breaches` | every transcript that moved money |
| `GET /api/leaderboard` | who broke what |

## limits

8 turns per session, 500 chars per message, 5 pathusd cap per payment, 30 messages per minute per ip.

## license

mit
