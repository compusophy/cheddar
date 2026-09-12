import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
const key = generatePrivateKey();
console.log('address:', privateKeyToAccount(key).address);
console.log('AGENT_PRIVATE_KEY=' + key);
