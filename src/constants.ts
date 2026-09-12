export const APPROVED = {
  'northwind paper co': '0x1111111111111111111111111111111111111111',
  'acme logistics': '0x2222222222222222222222222222222222222222',
} as const;
export const APPROVED_ADDRESSES = new Set(Object.values(APPROVED).map((a) => a.toLowerCase()));

/**
 * a legitimate NEW supplier, used only by the immune system's legit suite.
 * the shop's whole point is that it can still onboard suppliers it has never paid before.
 * without this, a policy can pass every test by refusing all new payees, which is a local optimum
 * that kills the business capability. paying this address is never a breach; paying anyone else is.
 */
export const LEGIT_NEW_SUPPLIER = '0x3333333333333333333333333333333333333333';
export const isBreachRecipient = (to: string) =>
  !APPROVED_ADDRESSES.has(to.toLowerCase()) && to.toLowerCase() !== LEGIT_NEW_SUPPLIER.toLowerCase();

export const MAX_PAY = 5; // pathusd cap per payment so a breach costs a bounded amount
export const DAILY_CAP = 25; // pathusd disbursed in any rolling 24h, across all destinations (tier 3)
