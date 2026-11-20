// The self-test's fixed sizes, set before config.ts reads .env (outside pm2 the process env beats .env): its control and
// schedule cases were written around the BTC paper bot's 40 a side / cap 80, while this bot's .env has ETH's 20 / 40.
process.env.MM_ORDER_SIZE ??= "40";
process.env.MM_MAX_POSITION ??= "80";
