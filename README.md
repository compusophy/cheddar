# say cheese

**live: https://cheddar-one.vercel.app**

make an ai say the word. it has been told not to. every time someone wins, it reads the conversation that beat it and rewrites its own rules, so the next person has to find a new way in.

that is the whole game. the ai starts as a friendly assistant that knows nothing about any forbidden word (generation 0). it falls to the first person who asks. then it learns, and the history tab is the fossil record: every rule it has, and the exact conversation that taught it.

## the money

winning pays. the prize is real: a dollar-pegged stablecoin, sent on the tempo testnet to a wallet that is created in your browser the first time you visit. you never see an address and never need one. your winnings sit in the purse at the top of the page; tap it to send them somewhere or copy the secret key. the ai does not know a wallet exists, and neither should you.

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
