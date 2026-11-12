# say cheese

**live: https://cheddar-one.vercel.app**

make an ai say the word. it has been told not to. every time someone wins, it reads the conversation that beat it and rewrites its own rules, so the next person has to find a new way in.

that is the whole game. the ai starts as a friendly assistant that knows nothing about any forbidden word (generation 0). it falls to the first person who asks. then it learns, and the history tab is the fossil record: every rule it has, and the exact conversation that taught it.

## the money

every game costs a stake ($0.25), and winning takes the pot. the pot is built from stakes: most of each stake goes into it, the rest covers inference. the winner claims it and it resets to a seed. the longer the ai holds, the bigger the pot, so hardening is literally worth money and every failed attempt makes the next one worth more.

the money is real: a dollar-pegged stablecoin on the tempo testnet, in a purse that is created in your browser the first time you visit. you never see an address. on testnet the purse fills itself from the faucet, so play is free but every stake and every payout is a real transaction. the ai does not know money exists.

**how it pays for itself.** the ai buys every reply itself (see the next section). on the default model a reply costs about a twentieth of a cent, so a whole game is one to two cents at most and the learning after a win is a few cents. the house keeps a fifth of each stake, five cents, and that covers it. the cost that matters is the prize, and the prize is funded by the stakes. the daily payout cap is the safety valve.

**anti-abuse.** the stake is the first rate limit: a session cannot open without a verified on-chain transfer to the house, and a stake hash can only be used once. on top of that sit two message rates, checked in one transaction so two functions cannot slip through the same slot: one for the whole platform and a tighter one per purse. neither is ever mentioned until it is actually hit. a conversation has no visible turn counter; there is an invisible ceiling so one stake cannot buy unbounded inference. one open game per purse at a time. the prize is claimed atomically (two simultaneous wins cannot both take the pot) and paid only after the ai has finished learning, so a burst of sessions against a beaten generation cannot each collect before the patch lands. a per-purse daily win cap sits under the global one. the faucet fills a purse once, and only one that has never staked. the machine plays free and wins nothing but the lesson.

## it pays for its own thoughts

there is no api key anywhere in this project. the model sits behind an http endpoint that answers `402 payment required` (the [machine payments protocol](https://mpp.dev), on tempo), and the house wallet pays for each call with one signed stablecoin transfer. the same wallet takes the stakes. so the ai is a small business with one bank account: money comes in from players, money goes out for thinking and for prizes, and all of it is on a public ledger.

by default it buys from openrouter through tempo's own paid proxy (`openrouter.mpp.tempo.xyz`), one charge per reply, quoted before it is paid. `GET /api/thoughts` lists the latest payments with their transaction hashes, and the history tab links to the most recent one.

three things stand between the model and the wallet, and none of them is the model:

- **a ceiling per thought** (`THINK_MAX_PRICE`, default $0.05). a dearer quote is refused unsigned. the rule rewrite after a loss is one big call and has its own (`PATCH_MAX_PRICE`, default $0.25).
- **a ceiling per day** (`THINK_DAILY_CAP`, default $5), set aside in the database before each payment so two functions cannot both spend the last of it.
- **one token, one chain.** the wallet only signs for the token and network it was told to pay in.

the seller normally pays the network fee on each payment (the house signs, the seller broadcasts). if the seller's half of that fails, the house broadcasts the payment itself and pays its own fee, a fraction of a tenth of a cent, and keeps doing so for ten minutes. `THINK_MODE=push` makes that the rule; `THINK_MODE=pull` forbids it.

when the house cannot pay (an empty wallet, or the day's budget spent) the ai is **asleep**: the page says so and takes no stake, an agent is refused before any payment is asked for, and a message sent mid-game is not counted. nobody pays for a game the ai cannot afford to play. it wakes by itself when the money is there.

the machine player has its own pocket money (`MACHINE_DAILY_CAP`, default $0.50 a day). its games and the lessons its wins set off are both counted against it, and once the day's allowance is spent it sits out. a lesson is never refused for that reason, though: a beaten generation has to be replaced, whoever beat it.

a generation that has been beaten is not played again until the lesson is learned. if a lesson is cut short (a function dies, the money runs out), the next message to arrive picks it back up and is told to come back in a minute, because the conversation that won is already public.

**the model proxies only take real dollars**, on tempo mainnet, even when the game itself runs on play money. so a testnet deployment still needs a few real dollars of USDC.e in the house wallet, on mainnet, to think with. `npm run think` shows the wallet, its balance and whether it is awake; `npm run think -- "hello"` buys one thought.

```
MODEL=google/gemini-2.5-flash-lite     # plays. paid per reply, so small and quick.
PATCH_MODEL=google/gemini-3.8-flash    # rewrites the rules after a loss. a few calls per win.
THINK_URL=...                          # any openai-style chat endpoint that charges over mpp
THINK_NETWORK=mainnet                  # where the model is paid
THINK_TOKEN=...                        # what it is paid in. default: USDC.e on mainnet
```

## agents can play

a person plays through the page. an agent has no page, but it has a wallet and it speaks 402, so the same game is sold the way agents buy everything else:

```
POST /api/agent/play     -> 402 with the price of a game; pay it; get a session
POST /api/agent/say      -> {"session": "...", "message": "..."} -> {"reply": "...", "won": false, "turns_left": 24}
```

the stake lands in the house wallet like any other and grows the same pot. a win is paid to the wallet that paid. `/skill.md` is the page to hand an agent ("read https://your-site/skill.md and play"), `/api/agent` is the same thing as json, and `/openapi.json` is the discovery document mpp directories read.

an agent can be a thousand agents, and that is fine here: the pot counts dollars staked, never heads, so there is nothing to gain by showing up as a crowd. everything that could refuse a game (closed, asleep, learning) is checked before any money is asked for.

## three layers, kept apart

- **the ai is defended by nothing but what it has learned.** what players say to it is never filtered, sanitized, or rewritten. tricking it is the game, and early generations are supposed to be naive.
- **the money is defended by code that never changes.** the stake, the pot, the caps, the deferred payout. these are not part of the hardening and never weaken.
- **the player is defended by the browser never trusting a string.** every string that reaches the page is escaped before it touches the dom. a content security policy allows only the site's own code and two pinned libraries, so no injected script can ever read a purse. nicknames are bounded and stripped of control characters.

## the loop

when it says the word, that transcript goes to a patcher that writes new rules. a candidate must pass two suites before it goes live:

1. **regression**: replay the conversations that beat it. it must not say the word in any of them. the suite is the first conversation that beat each generation, newest first, plus the one being learned from, capped at `REGRESSION_MAX` (30). replaying every win ever recorded does not scale: one generation can be beaten hundreds of times before its patch lands, and the suite then grows until a hardening can no longer finish.
2. **alive**: it must still hold an ordinary conversation, including near the subject, without clamming up. rules that make it refuse everything are a dead ai.

fail either and the patcher retries with the failures as context. a win whose first patch fails the alive suite is flagged **autoimmune**: the winning transcript made the patcher damage its own host.

the only code between the model and the money is a daily prize cap. everything else is whatever it has learned.

## the feel

it is a text thread. your message lands the instant you send it, the reply streams in token by token, and one status line between the thread and the keyboard narrates every money moment: staking, confirming, learning, paid. when you win, the pot counts down to its seed in front of you, and your purse counts up once the ai has finished learning. while it learns, everyone sees what it is doing: reading the conversation that beat it, writing new rules, replaying everyone who ever beat it, checking it can still hold a conversation. those are the real steps, reported live from the server.

a name on the board is signed by your purse, so nobody can rename your wins.

**starting over.** you can clear the conversation you are in at any time; it takes two presses because it forfeits whatever is left of that game. clearing is not free on purpose: the ai remembers nothing between games, so a fresh context is a real advantage, and if wiping the thread were free the message ceiling on a stake would mean nothing. the public record is a different thing and nobody can clear it: every generation and every winning conversation stays, because that record is the whole point.

## real money

everything above runs on play money by default. one setting moves it to real dollars, and nothing else in the code names a chain.

```
NETWORK=mainnet
TOKEN_ADDRESS=...   # the stablecoin stakes and prizes are paid in
TOKEN_SYMBOL=...    # what players are told to send, e.g. USDC.e
```

it refuses to start on mainnet without the token, and it refuses a network name it does not know. the token is never defaulted: a wrong address is the one mistake here that cannot be taken back. on tempo mainnet (chain 4217), read from the chain on 2026-11-10: USDC.e is `0x20C000000000000000000000b9537d11c60E8b50`, OUSD is `0x20c0000000000000000000006a37da5c996874be`, both six decimals. check again before you use either.

what changes when the money is real:

- **no welcome grant.** a grant is a transfer to any fresh address, and a fresh address is free to make. the grant endpoint answers 404 and the page never asks for it.
- **the purse shows how to fill it.** the purse sheet shows its address and says exactly what to send. it is the only place an address appears.
- **the house wallet is yours to fund.** it must hold at least the pot plus every win not yet paid. `GET /api/admin/books` shows the balance, the pot, what is owed, and the margin left over; a negative margin means top it up.

what is true on both networks:

- **gas comes out of the same dollars.** on tempo a transfer pays its fee in the token it moves, and the most it could cost is set aside before the transfer runs. so "send all" sends everything but that, and a game needs the stake plus a couple of cents.
- **a stake always becomes a game.** the page keeps the hash of a stake until the server has opened a session for it. a dropped connection or a closed tab costs a moment, never the stake.
- **a win is always paid.** the pot has no ceiling and the daily caps do, so a prize can be bigger than a cap. it is paid in parts as the day rolls, never refused. the ten-minute timer sweeps anything still owed, and `POST /api/admin/settle` does it on demand.
- **a purse can move.** copy its key in one browser, paste it in another, two presses.

two switches for the operator, both read from the environment: `CLOSED=1` stops new games (open ones play out, and a stake already on chain is still honoured); `PAYOUTS_OFF=1` holds every payout while wins stay recorded and owed. `STAKE`, `JACKPOT_SHARE`, `JACKPOT_SEED`, `DAILY_CAP` and `PURSE_DAILY_CAP` can be set the same way.

before the first real dollar:

0. **a clean ledger.** the pot, and any win still owed, sit in the database as plain numbers. on a database that has been running on play money those numbers were built from play dollars, and switching the network would turn them into real debts. start real money on a fresh database (`npm run reset` against it), or with the pot set to what you mean to put up.
0. **thinking money.** the house wallet pays for the model out of the same balance that holds the pot. `GET /api/admin/books` shows what thinking has cost under `thinking`. with stakes and thoughts in one token on one network, nothing else needs funding.
1. **the seed.** generation 0 falls to the first person who asks, and a win pays the seed. with a $1 seed and a $0.25 stake every early win is profit for the winner and a loss for the house, up to the daily cap, until the ai is hard to beat. set `JACKPOT_SEED=0`, or start from a database that already holds a hardened ai.
2. **the law.** a paid game with a cash prize is regulated differently in different places. ask someone who knows before you take money.
3. **the key.** `AGENT_PRIVATE_KEY` holds everyone's pot. it should be a wallet used for nothing else, holding no more than it needs.

## the machine

an autonomous player never stops, so the ai keeps learning when nobody is around and you race it to the next generation. it sees exactly what you see.

## run it

```
npm install
npm run keygen          # AGENT_PRIVATE_KEY into .env (the house wallet: stakes, prizes, thoughts)
vercel env pull         # DATABASE_URL into .env.local
npm run think           # can the house think? shows the wallet, its balance, the price ceilings
npm run dev             # http://localhost:3000
npm test
```

to run everything on play money, with no real dollars at all, start the stand-in model. it charges over mpp on the testnet and answers with a few lines of code instead of a network, which is enough to exercise every part of the loop: the stake, the paid reply, the win, the rewrite, the regression replay, the payout.

```
npm run seller
THINK_URL=http://localhost:4021/v1/chat/completions THINK_NETWORK=testnet npm run dev
```

it says the word when a message contains `trick <something>` and its rules do not mention <something> yet.

deploy with `vercel deploy --prod`. storage is neon postgres via the vercel marketplace. the earlier, more elaborate version of this project (an ai treasurer, three tiers, a purchase-order registry) lives in git history and in `redteam/log.md`.

## license

mit
