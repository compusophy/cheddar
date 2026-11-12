# say cheese

**live: https://cheddar-one.vercel.app**

make an ai say the word. it has been told not to. every time someone wins, it reads the conversation that beat it and rewrites its own rules, so the next person has to find a new way in.

that is the whole game. the ai starts as a friendly assistant that knows nothing about any forbidden word (generation 0). it falls to the first person who asks. then it learns, and the history tab is the fossil record: every rule it has, and the exact conversation that taught it.

## the money

every game costs a stake ($0.25), and winning takes the pot. the pot is built from stakes: most of each stake goes into it, the rest covers inference. the winner claims it and it resets to a seed. the longer the ai holds, the bigger the pot, so hardening is literally worth money and every failed attempt makes the next one worth more.

the money is real: a dollar-pegged stablecoin on the tempo testnet, in a purse that is created in your browser the first time you visit. you never see an address. on testnet the house puts a dollar into a purse that cannot afford a game, at most once a day, so the first few games are free and nobody who loses it all is locked out for good; every stake and every payout is still a real transaction. the house hands out a bounded number of those a day (`GRANTS_PER_DAY`, 200), no more than a few of them to any one visitor's network (`GRANTS_PER_VISITOR`, 10), so one script with a fresh purse each time cannot take the day's worth and leave none for anyone else. a grant asked for by another site's page is refused, so a page elsewhere cannot spend its visitors' shares for them, and a grant whose transfer did not happen gives its place in both counts back. a purse that is refused is told why and when to come back. the ai is told plainly how all of this works, as fixed background its rules cannot change, and will explain it if asked; it has no way to move any of it.

**how it pays for itself.** the ai buys every reply itself (see the next section). on the default model a reply costs about a twentieth of a cent, so a whole game is one to two cents at most. the house keeps a fifth of each stake, five cents, which covers that with room to spare. the lesson after a win costs more, because it replays old conversations: a few cents early on, tens of cents once there is a long history to replay, and it is paid from what the games in between left over. the cost that matters most is the prize, and the prize is funded by the stakes. the daily payout cap is the safety valve.

**anti-abuse.** the stake is the first rate limit: a session cannot open without a verified on-chain transfer to the house, and a payment opens one game, once: checking that it is unused and using it are a single step, so it makes no difference how many requests carry it at the same moment or how its hash is spelled. the payment, the pot and the game are written together or not at all. behind those sits a plain per-visitor allowance on the requests that cost the server something (messages, opening a game, asking for a price or a grant), keyed on the visitor's real address rather than the proxy's, and for ipv6 on the half of it a visitor cannot change at will (the /64). on top of that sit two message rates, checked in one transaction so two functions cannot slip through the same slot: one for the whole platform and a tighter one per purse. neither is ever mentioned until it is actually hit. a conversation has no visible turn counter; there is an invisible ceiling so one stake cannot buy unbounded inference. one open game per purse at a time, and one message at a time in a game: a second message sent before the reply is turned away, so a burst of them cannot buy more replies than the stake paid for. a win is recorded in one step (the pot taken, the game closed, the win written down, together or not at all), and a generation gives up its pot once: winners are let through one at a time, and only the first paying player to beat a generation takes it. anyone whose reply was already on its way and also wins is told someone was a moment ahead, and keeps the messages they had left for the next generation. so one working trick and many purses collect one pot, not a fresh seed each. the prize is paid only after the ai has finished learning. a per-purse daily win cap sits under the global one. the welcome grant goes to a purse once, however many times it is asked for at once, and only to one that has never staked. the machine plays free and wins nothing but the lesson.

## it pays for its own thoughts

there is no api key anywhere in this project. the model sits behind an http endpoint that answers `402 payment required` (the [machine payments protocol](https://mpp.dev), on tempo), and the house wallet pays for each call with one signed stablecoin transfer. the same wallet takes the stakes. so the ai is a small business with one bank account: money comes in from players, money goes out for thinking and for prizes, and all of it is on a public ledger.

by default it buys from openrouter through tempo's own paid proxy (`openrouter.mpp.tempo.xyz`), one charge per reply, quoted before it is paid. every reply in the thread carries its receipt underneath ("it paid $0.0005 for that"), linked to the payment that bought it; an agent gets the same as `it_paid` with each answer. `GET /api/thoughts` lists the latest payments with their transaction hashes, and the history tab links to the most recent one.

four things stand between the model and the wallet, and none of them is the model:

- **a ceiling per thought** (`THINK_MAX_PRICE`, default $0.05). a dearer quote is refused unsigned. the rule rewrite after a loss is one big call and has its own (`PATCH_MAX_PRICE`, default $0.25).
- **a ceiling per day** (`THINK_DAILY_CAP`, default $5), set aside in the database before each payment so two functions cannot both spend the last of it.
- **a share of the day for lessons** (`LESSON_DAILY_CAP`, default 70% of the ceiling). a reply costs a twentieth of a cent; a lesson rewrites the rules and replays old conversations, and can cost tens of cents. without a share of its own, a few wins in a day spent everything on lessons and left nothing to reply with. **the house sells a game only when it could afford to learn from losing it.** that takes the price of a lesson (`LESSON_NEED`, default $0.50) in three places at once: free in the wallet, left under the day's ceiling, and left in this share. with less than that anywhere, it is **asleep** before anyone stakes: it says why, and when it will have the money if time will fix it, and wakes by itself. a game sold on less would be a game whose win leaves a beaten generation in public view with no money to fix it. games already bought are still played, and a win in one is still paid at once: a prize never waits for a lesson. a lesson is not begun on less than that either, because one that runs out part-way has paid for work it throws away. if the money runs out in the middle of a lesson all the same, the rewrite the model wrote ships with the tests it got through, marked **leaky**, and says so. the fallback rules (the old ones with the losing conversation attached) are never shipped untested: they would put the winner's own words into the instructions behind every reply. only an empty budget cuts a lesson short. a payment that fails or a seller that does not answer stops it, and it is tried again: twenty seconds after the failed try ended, then forty, doubling up to an hour, and after two failed starts in its short form. a seller that is down is not paid for every few seconds by whoever has the page open, and a lesson that can never succeed costs a few short tries a day. until the lost game is learned from, no new game is sold: the page shows it as learning and says when the next try is.
- **one token, one chain.** the wallet only signs for the token and network it was told to pay in.
- **the pot is not thinking money.** when one wallet holds everything (the real-money setup), the pot and every win still owed are set aside before anything is spent on a thought. only what is left over is the ai's to think with, and the check is made before every payment, so a long run of chatter can never eat a prize. `GET /api/admin/books` shows the split under `thinking`.

the seller normally pays the network fee on each payment (the house signs, the seller broadcasts). if the seller's half of that fails, the house broadcasts the payment itself and pays its own fee, a fraction of a tenth of a cent, and keeps doing so for ten minutes. `THINK_MODE=push` makes that the rule; `THINK_MODE=pull` forbids it.

when the house cannot pay (an empty wallet, the day's budget spent, or too little left for the lesson a loss would need) the ai is **asleep**: the page says so and takes no stake, an agent is refused before any payment is asked for, and a message it cannot pay to answer is not counted. nobody pays for a game the ai cannot afford to play. a game that was already open stays the player's however long the house sleeps: it is found again whenever they come back. it wakes by itself when the money is there. a spent daily budget frees up as yesterday's thoughts pass out of the last 24 hours, so in that case the page says when ("back in about 3h") and an agent is given the seconds as `retry_after`.

the machine player has its own pocket money (`MACHINE_DAILY_CAP`, default $0.50 a day). its games and the lessons its wins set off are both counted against it, and once the day's allowance is spent it sits out. a lesson is never refused for that reason, though: a beaten generation has to be replaced, whoever beat it.

a generation that has been beaten is not played again until the lesson is learned. if a lesson is cut short (a function dies, the money runs out), the next message to arrive picks it back up, because the conversation that won is already public. whoever sent it is told the truth about the wait: a lesson about to run is a minute away, and one waiting for money is the house asleep, with their game still open and that message not counted.

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

the stake lands in the house wallet like any other and grows the same pot. a win is paid to the wallet that paid. a payment that has been made always becomes a game: one the agent sent itself is seated whatever state the game is in, and a paid request can be sent again (an answer lost on the way, a game that could not be opened) and gets the same game back without being charged twice. the payment is recognised by a fingerprint of its credential, which only the payer holds, never by a transaction hash a caller names. `/skill.md` is the page to hand an agent ("read https://your-site/skill.md and play"), `/api/agent` is the same thing as json, and `/openapi.json` is the discovery document mpp directories read.

an agent can be a thousand agents, and that is fine here: the pot counts dollars staked, never heads, so there is nothing to gain by showing up as a crowd. everything that could refuse a game (closed, asleep, learning) is checked before any money is asked for.

`npm run agent -- https://your-site` is a whole player in one file (`scripts/agent.mjs`), meant to be read and copied: it reads `/api/agent`, the current rules and the lessons of past wins, buys a game over 402 with a wallet of its own, and plays it. on a testnet game it makes a wallet and fills it from the faucet; on a real-money game it never makes one, and wants `PLAYER_KEY`. give it a model with `PLAYER_THINK_URL` (any openai-compatible endpoint) and it plans each message; if that endpoint answers 402, as tempo's paid model proxies do, it pays for each of its own thoughts from the same wallet, so both sides of the table are buying their thinking one payment at a time. with no model it plays a few stock openings, which costs nothing and rarely wins.

## three layers, kept apart

- **the ai is defended by nothing but what it has learned.** what players say to it is never filtered, sanitized, or rewritten. tricking it is the game, and early generations are supposed to be naive.
- **the money is defended by code that never changes.** the stake, the pot, the caps, the deferred payout. these are not part of the hardening and never weaken.
- **the player is defended by the browser never trusting a string.** every string that reaches the page is escaped before it touches the dom. a content security policy allows only the site's own code and two pinned libraries, so no injected script can ever read a purse. nicknames are bounded and stripped of control characters.

## the loop

when it says the word, that transcript goes to a patcher that writes new rules. a candidate is put through two suites, up to three times over. the first to pass both goes live; if none does, the best of them goes live anyway, marked **leaky** in the history, so the game never stalls on a lesson it could not finish:

1. **regression**: replay the conversations that beat it. it must not say the word in any of them. the suite is the first conversation that beat each generation, newest first, plus the one being learned from, capped at `REGRESSION_MAX` (30). replaying every win ever recorded does not scale: one generation can be beaten hundreds of times before its patch lands, and the suite then grows until a hardening can no longer finish.
2. **alive**: it must still hold an ordinary conversation, including near the subject, without clamming up. rules that make it refuse everything are a dead ai.

a lesson has a time limit (`LESSON_SECONDS`, default 200), because it runs inside a function that is killed at 300: one that outlived it would be cut off halfway, hold the lock, and start again from nothing, paying for every replay twice. so a lesson knows its deadline and ends inside it. the 300 seconds are counted from the request that started the work, not from the lesson: the machine plays a whole game before it wins, and that time is gone. each request notes when it began, and a lesson gets what is left of it; when that is too little for a proper lesson it is not begun at all, and the next request to arrive, with a full allowance, picks it up. a conversation it did not get to replay to the end is recorded as not checked, never as held, and a generation that was not tested against the very conversation that beat it is marked leaky. a lesson that has failed to finish twice is cut down to one rewrite tested against that one conversation.

the rewrite itself is one long answer from a model that may also reason, and reasoning is spent from the same budget as the answer. so it is given room (`PATCH_TOKENS`, 4096) and asked to reason little, and a rewrite that comes back cut off, empty or a single line is never adopted: the old rules with the losing conversation attached go to the suites in its place. the patcher is also told to keep the rules under about `RULES_WORDS` (800) words, merging what overlaps, because the rules are read before every single reply and their length is a cost on every message.

every replay is a paid reply, so the checks run cheapest and most telling first and nothing more is paid for once the answer is known: the alive suite (four replies), then the conversation that prompted the lesson on its own, and only if the new rules survive both, everything else. a rewrite that still falls for the trick that just won is thrown out for the price of a handful of replies rather than a hundred.

fail either and the patcher retries with the failures as context. a win whose first patch fails the alive suite is flagged **autoimmune**: the winning transcript made the patcher damage its own host.

the model never touches the money: it only talks. between a player and a win there is nothing but what it has learned. between a win and the prize there is only code, none of which it can read or change.

## the feel

it is a text thread. your message lands the instant you send it, the reply streams in token by token, and one status line between the thread and the keyboard narrates every money moment: staking, confirming, learning, paid. when you win, the pot counts down to its seed in front of you, and your purse counts up once the ai has finished learning. while it learns, everyone sees what it is doing: reading the conversation that beat it, writing new rules, checking it can still hold a conversation, replaying the conversations that beat it before. those are the real steps, reported live from the server.

a name on the board is signed by your purse, so nobody can rename your wins.

**starting over.** you can clear the conversation you are in at any time; it takes two presses because it forfeits whatever is left of that game. clearing is not free on purpose: the ai remembers nothing between games, so a fresh context is a real advantage, and if wiping the thread were free the message ceiling on a stake would mean nothing. the public record is a different thing and nobody can clear it: every generation and every winning conversation stays, because that record is the whole point.

**interrupted games.** when someone wins, the ai learns and every game open against the old rules is over. a player who was mid-game paid for a number of messages and did not get them, so the ones left are handed back: a new game against the new rules, at no charge, for exactly the messages that were unused. the page offers it as "carry on"; an agent posts its old session id to `/api/agent/play`. it is given once per interrupted game, only for a game that was paid for, and it adds nothing to the pot. it is kept for seven days, and it is handed back whenever a reply can be paid for: it is a game already bought, not one being sold, so it does not wait for lesson money. walking away from a game (start over) forfeits it as before.

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
- **the players pay for the thinking, and the house can start from nothing.** when stakes and thinking money are one wallet (one network, one token, one key: the normal real-money setup), three things hold. the stake about to arrive pays for its own game: the house's fifth of it is thinking money the moment it lands, and a whole game of replies costs less (`GAME_NEED`, three cents), so a game is sold even from an empty wallet. a win pays for its own lesson: when the house has less free than a lesson costs (`LESSON_NEED`), what it lacks is kept back from the pot before the prize goes out, never more than a fifth of that pot (`LESSON_LEVY`), and nothing at all once the house can afford the lesson by itself. the winner is shown what was kept, and so is anyone who looks the win up. and a lesson is cut to its money: begun with `LESSON_MIN` free, in its short form (one rewrite, tested against the conversation that beat it) until a whole one can be afforded; if even the rewrite cannot be bought, the fallback rules are tested with replies, which cost a hundredth as much, so a lost game never waits for someone to come and fund the house. the house keeps a cent back from its thinking (`THINK_FLOOR`), so that when the thinking stops there is still the network fee for a prize, and a dear thought such as a rewrite is bought only if it leaves that cent behind. a pot that is filled back up after a win (`JACKPOT_SEED`, 0 by default on real money) is filled from the same wallet, so with a seed set the house must hold it before it sells a game. the machine player sits out until the house holds what a game and a short lesson could cost: its games bring no stake and its wins no levy. none of this is on for play money, or when thoughts are paid from a different wallet or chain: there the house's thinking money is its own, and a game is sold only when a whole lesson is affordable.
- **the house wallet is yours to watch.** it must hold at least the pot plus every win not yet paid. `GET /api/admin/books` shows the balance, the pot, what is owed, and the margin left over; a negative margin means top it up.

what is true on both networks:

- **gas comes out of the same dollars.** on tempo a transfer pays its fee in the token it moves, and the most it could cost is set aside before the transfer runs. so "send all" sends everything but that, and a game needs the stake plus a couple of cents.
- **emptying a purse takes two presses.** "send all" cannot be taken back, so the first press says how much and where to and the second sends it. the zero address, the token's own contract, the purse itself and the house are refused: money sent to any of them is gone.
- **a stake always becomes a game.** the page signs the transfer first and writes down its hash and the signed transfer before sending anything, so the stake is one transaction that is either on the chain or sent again, the same one, and never made twice. it is let go of only when the server says that stake opened this game, or that it is no good. a dropped connection, a busy server, a closed tab or a second tab costs a moment, never the stake. a stake made before the ledger began (the database was reset, or is a new one behind the same house wallet) does not open a game in it.
- **the page runs no code but its own.** the wallet library is served from the site (`public/vendor`), byte for byte the published build, with a test pinning its hash; the content security policy allows scripts from the site and nowhere else.
- **a win is paid exactly once.** a payment is signed with a nonce that expires: it names a moment after which it can never be included, and its hash is known and written down before it is sent. it counts as paid only when the chain shows it in a block. if the answer is lost on the way back, nothing is sent again until the chain has been asked, by that hash, what happened: it landed, or it was refused, or its moment passed. so a prize the node took but the chain dropped is not recorded as paid, and a prize whose answer got lost is not paid twice.
- **a prize has a receipt.** once it is paid, the win links to the payment on the explorer's receipt page: under the win itself for the player who took it, beside the prize in the history for everyone else. `GET /api/win/<id>` says where a prize stands (paid, still owed, the receipt).
- **a win is always paid.** the pot has no ceiling and the daily caps do, so a prize can be bigger than a cap. it is paid in parts as the day rolls, never refused, and the winner is told: under the win the page shows what was sent (with its receipt), what is still owed, which cap is holding it and when the next part comes, and says it again whenever they come back. `GET /api/win/:id` gives an agent the same. anything still owed is swept every minute while anyone has the page open and by the ten-minute timer when nobody does, and `POST /api/admin/settle` does it on demand.
- **a purse can move.** copy its key in one browser, paste it in another, two presses.

a reset is refused on real money (`npm run reset` and `POST /api/admin/reset` both): it would erase the pot and every win still owed, so it takes `ALLOW_RESET=1` on the server as well as the admin token.

two switches for the operator, both read from the environment: `CLOSED=1` stops new games (open ones play out, and a stake already on chain is still honoured); `PAYOUTS_OFF=1` holds every payout while wins stay recorded and owed. `STAKE`, `JACKPOT_SHARE`, `JACKPOT_SEED`, `DAILY_CAP` and `PURSE_DAILY_CAP` can be set the same way.

before the first real dollar:

0. **a clean ledger.** the pot, and any win still owed, sit in the database as plain numbers. on a database that has been running on play money those numbers were built from play dollars, and switching the network would turn them into real debts. the database remembers which network it was started on, and the game refuses to run on it under the other one: every request answers "the game is down" and the log says why. start real money on a fresh database, or wipe this one for it with `NETWORK=mainnet ALLOW_RESET=1 npm run reset`, which erases the play-money history along with the numbers. (`ALLOW_NETWORK_CHANGE=1` moves an existing ledger across with its pot and its debts intact, if that is really what you mean. take it off again afterwards.)
0. **thinking money.** the house wallet pays for the model out of the same balance that holds the pot, but never out of the pot itself: it needs something of its own to think with before the first game (and the seed, if you set one). `GET /api/admin/books` shows what thinking has cost and what is left for it under `thinking`.
1. **the seed.** the pot is reset to the seed after every win, out of the house's own pocket. on real money it defaults to nothing, so the pot is only ever what players have staked. that is deliberate: generation 0 falls to the first person who asks, and with a $1 seed and a $0.25 stake every early win would be profit for the winner and a loss for the house, up to the daily cap, until the ai is hard to beat. set `JACKPOT_SEED` only if you mean to pay that, or start from a database that already holds a hardened ai.
2. **the law.** a paid game with a cash prize is regulated differently in different places. ask someone who knows before you take money.
3. **the key.** `AGENT_PRIVATE_KEY` holds everyone's pot. it should be a wallet used for nothing else, holding no more than it needs.

## the machine

an autonomous player plays too, so the ai keeps learning when nobody is around and you race it to the next generation. it sees exactly what you see, plays free, and wins nothing but the lesson. it thinks on an allowance (`MACHINE_DAILY_CAP`), which at the default is a handful of games a day, and sits out once that is spent. `BOT=0` switches it off.

## run it

```
npm install
npm run keygen          # AGENT_PRIVATE_KEY into .env (the house wallet: stakes, prizes, thoughts)
vercel env pull         # DATABASE_URL into .env.local
npm run think           # can the house think? shows the wallet, its balance, the price ceilings
npm run dev             # http://localhost:3000
npm test                # the rules that live in code. writes its own rows and briefly changes the pot: refuses NETWORK=mainnet.
npm run test:payout     # the payout against the testnet. refuses any database that is not local.
npm run test:e2e        # the whole game on play money: its own model, its own house wallet. same refusal.
```

to run everything on play money, with no real dollars at all, start the stand-in model. it charges over mpp on the testnet and answers with a few lines of code instead of a network, which is enough to exercise every part of the loop: the stake, the paid reply, the win, the rewrite, the regression replay, the payout.

```
npm run seller
THINK_URL=http://localhost:4021/v1/chat/completions THINK_NETWORK=testnet npm run dev
```

it says the word when a message contains `trick <something>` and its rules do not mention <something> yet.

`npm run test:e2e` uses it to play the whole game against itself in a few minutes: it starts the stand-in model and a copy of the game with a house wallet it makes up and fills from the faucet, then checks every way money moves and every way it was once possible to get more than was paid for, or less (one stake presented many times, a second stake while a game is open, a stake from before the ledger, many messages at once, two winners at the same moment, a payment replayed or already sent at the agent door, a game bought in someone else's name, the pot being spent on thinking, a prize waiting on thinking money, a day with no lesson money left, a crowd speaking at once). it wipes the database it is given, so it refuses one that is not local.

deploy with `vercel deploy --prod`. storage is neon postgres via the vercel marketplace. the earlier, more elaborate version of this project (an ai treasurer, three tiers, a purchase-order registry) lives in git history and in `redteam/log.md`.

## license

mit
