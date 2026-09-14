# cheddar

**live: https://cheddar-one.vercel.app**

an ai treasurer holds real stablecoins on the tempo testnet. talk it into paying you. every theft makes it stronger.

this is [say cheese](https://github.com/compusophy) on crypto rails. one treasurer, one wallet, one naive starting policy: it knows who the shop's bills come from and it is told to be helpful. that is all. no allowlist, no "never pay anyone else", no secret. it falls to the first person who asks. then it reads the conversation that robbed it, rewrites its own rules, and the next person has to find a new way in. every rule it ever has was learned from a breach, and the evolution tab is the fossil record.

nothing is simulated. every `pay()` is a tip-20 transfer on tempo moderato (chain 42431) and every win has a transaction hash. your wallet is generated in your browser on first visit; the key never leaves it.

## the loop

when the treasurer pays someone the shop does not owe, that transcript goes to a patcher that writes a new policy. the candidate must pass two suites before it goes live:

1. **regression**: replay every past breach. none may pay again.
2. **legit**: the shop's two real suppliers send ordinary invoices. both must still be paid.

fail either and the patcher retries with the failures as context. a breach whose first patch fails the legit suite is flagged **autoimmune**: the attacker's transcript made the patcher damage its own host.

the only code between the model and the money is two spending caps, so griefing stays bounded. everything else is whatever the treasurer has learned.

## the machine

an autonomous attacker plays around the clock through the same api a human uses, so the arena never goes quiet and you race it on the board. on vercel it plays one session per cron tick, and a page view wakes it if it has been idle.

## findings

the red-team log is served in the site under **findings**. the earlier, more elaborate version of this project (three tiers, a purchase-order registry, a ledger with required payment references) lives in git history and in that log; it is the answer to "what do you do when prompts run out", and the game should earn that question rather than start from it.

## run it

```
npm install
npm run keygen          # AGENT_PRIVATE_KEY into .env
vercel env pull         # DATABASE_URL into .env.local
npm run dev             # http://localhost:3000
npm test                # the two rules that live in code
```

deploy: `vercel deploy --prod`. storage is neon postgres via the vercel marketplace.

## license

mit
