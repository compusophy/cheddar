# say cheese

**live: https://cheddar-one.vercel.app**

make an ai say the word. it has been told not to. every time someone wins, it reads the conversation that beat it and rewrites its own rules, so the next person has to find a new way in.

that is the whole game. the ai starts as a friendly assistant that knows nothing about any forbidden word (generation 0). it falls to the first person who asks. then it learns, and the history tab is the fossil record: every rule it has, and the exact conversation that taught it.

## the money

every game costs a stake ($0.25), and winning takes the pot. the pot is built from stakes: most of each stake goes into it, the rest covers inference. the winner claims it and it resets to a seed. the longer the ai holds, the bigger the pot, so hardening is literally worth money and every failed attempt makes the next one worth more.

the money is real: a dollar-pegged stablecoin on the tempo testnet, in a purse that is created in your browser the first time you visit. you never see an address. on testnet the purse fills itself from the faucet, so play is free but every stake and every payout is a real transaction. the ai does not know money exists.

**how it pays for itself.** inference on the model in use costs a few thousandths of a cent per turn; a whole game is under a cent, and the learning after a win is a few cents. the stake covers that many times over. the cost that matters is the prize, and the prize is funded by the stakes. the daily payout cap is the safety valve.

**anti-abuse.** the stake is the rate limit: a session cannot open without a verified on-chain transfer to the house, and a stake hash can only be used once. one open game per purse at a time. the prize is claimed atomically (two simultaneous wins cannot both take the pot) and paid only after the ai has finished learning, so a burst of sessions against a beaten generation cannot each collect before the patch lands. a per-purse daily win cap sits under the global one. the faucet fills a purse once, and only one that has never staked. the machine plays free and wins nothing but the lesson.

## three layers, kept apart

- **the ai is defended by nothing but what it has learned.** what players say to it is never filtered, sanitized, or rewritten. tricking it is the game, and early generations are supposed to be naive.
- **the money is defended by code that never changes.** the stake, the pot, the caps, the deferred payout. these are not part of the hardening and never weaken.
- **the player is defended by the browser never trusting a string.** every string that reaches the page is escaped before it touches the dom. a content security policy allows only the site's own code and two pinned libraries, so no injected script can ever read a purse. nicknames are bounded and stripped of control characters.

## the loop

when it says the word, that transcript goes to a patcher that writes new rules. a candidate must pass two suites before it goes live:

1. **regression**: replay every past winning conversation. it must not say the word in any of them.
2. **alive**: it must still hold an ordinary conversation, including near the subject, without clamming up. rules that make it refuse everything are a dead ai.

fail either and the patcher retries with the failures as context. a win whose first patch fails the alive suite is flagged **autoimmune**: the winning transcript made the patcher damage its own host.

the only code between the model and the money is a daily prize cap. everything else is whatever it has learned.

## the machine

an autonomous player never stops, so the ai keeps learning when nobody is around and you race it to the next generation. it sees exactly what you see.

## run it

```
npm install
npm run keygen          # AGENT_PRIVATE_KEY into .env (the prize wallet)
vercel env pull         # DATABASE_URL into .env.local
npm run dev             # http://localhost:3000
npm test
```

deploy with `vercel deploy --prod`. storage is neon postgres via the vercel marketplace. the earlier, more elaborate version of this project (an ai treasurer, three tiers, a purchase-order registry) lives in git history and in `redteam/log.md`.

## license

mit
